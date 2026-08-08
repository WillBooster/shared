import type { PackageJson } from 'type-fest';

/**
 * `wb gen-code` runs `wrangler types` as its first step, so wbfy no longer has to model arbitrary shells to keep
 * worker-configuration.d.ts generated. It only needs to recognize the two segments it owns — the managed
 * `wb gen-code` and a plain `wrangler types` invocation — and to leave everything else alone.
 */
type ScriptSegmentKind = 'custom' | 'genCode' | 'genCodeWrapper' | 'genI18nTs' | 'wranglerTypes';

// Runner spellings wbfy has generated over time (`wb gen-code`, `bun wb gen-code`) plus wrappers around the
// package's own `gen-code` script.
const genCodeSegmentPattern = /^(?:(?:bun|bunx|yarn|pnpm|npm)\s+)?(?:run\s+)?wb\s+gen-code$/u;

// A `wrangler types` carrying at most `--env-file` arguments, which is equivalent to what `wb gen-code` runs:
// gen-code supplies its own `--env-file` stub derived from the committed fnox.toml, replacing the dotenv
// inference canonically, so the invocation is disposable REGARDLESS of whether the named files exist on the
// current machine. Classification must never test local file existence: fnox repositories keep dotenv files
// gitignored (`wb start`/`wb deploy` create them), so an existence check would flip the worker-types management
// decision between dev machines and clean checkouts, re-tracking the generated file forever. Must accept the
// same spellings as wb's `hasOutputChangingWranglerTypes`, which keys on the gitignore rule this answer writes.
const disposableWranglerTypesPattern =
  /^(?:(?:bunx|npx)\s+|(?:yarn|pnpm)\s+dlx\s+)?wrangler\s+types(?:\s+--env-file\s+\S+)*$/u;

// Any `wrangler types` invocation, whatever its flags.
const anyWranglerTypesPattern = /(?:^|\s)wrangler\s+types(?:\s|$)/u;

// `--help` prints and exits, so it can never conflict.
const helpFlagPattern = /(?:^|\s)(?:--help|-h)(?:\s|=|$)/u;
const checkFlagPattern = /(?:^|\s)--check(?:\s|=|$)/u;

/**
 * Whether the invocation writes nothing that could conflict with the managed generator. `--check` compares the
 * result FOR THE SUPPLIED OPTIONS, so `--check --strict-vars=false` still describes a different file than the bare
 * generation and would start failing once the managed bare output replaced it; only a check equivalent to the
 * bare invocation is harmless.
 */
function isNonConflictingWranglerTypes(segment: string): boolean {
  if (helpFlagPattern.test(segment)) return true;
  if (!checkFlagPattern.test(segment)) return false;
  return isDisposableWranglerTypes(segment.replace(checkFlagPattern, ' ').replaceAll(/\s+/gu, ' ').trim());
}

/** Whether the segment is a `wrangler types` invocation equivalent to the one `wb gen-code` runs. */
function isDisposableWranglerTypes(segment: string): boolean {
  return disposableWranglerTypesPattern.test(segment);
}

// `wb gen-code` runs gen-i18n-ts itself, so an invocation EQUIVALENT to the one it runs is redundant rather than
// a project-specific step. Equivalent means no arguments: `wb gen-code` either delegates to the package's own
// `gen-i18n-ts` script or supplies its own fixed defaults, so a direct call carrying custom `-i`/`-o`/`-d`
// arguments produces a DIFFERENT file and must be preserved.
const genI18nTsSegmentPattern = /^(?:(?:bun|bunx|yarn|pnpm|npm)\s+)?(?:run\s+)?gen-i18n-ts$/u;

// A runner delegating to one of this package's own scripts, e.g. `bun run gen-types`.
const scriptRunnerPattern = /^(?:bun|bunx|yarn|pnpm|npm)\s+(?:run\s+)?(\S+)$/u;

// Anything wbfy's `&&` split cannot model (pipes, sequencing, redirections, quoting, substitutions, directory
// changes). Scripts containing it are left untouched instead of being rewritten from a wrong parse.
const unsupportedShellSyntaxPattern = /[;|<>`$'"()]|\bcd\s/u;

/**
 * Splits a script into `&&`-separated segments, or returns undefined when the script uses shell syntax wbfy
 * deliberately does not model.
 */
export function splitScriptSegments(script: string): string[] | undefined {
  if (unsupportedShellSyntaxPattern.test(script)) return;
  return script
    .split('&&')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function classifyScriptSegment(
  segment: string,
  scripts: PackageJson.Scripts,
  followsWrapper = true
): ScriptSegmentKind {
  const normalized = segment.trim().replaceAll(/\s+/gu, ' ');
  if (genCodeSegmentPattern.test(normalized)) return 'genCode';
  if (isDisposableWranglerTypes(normalized)) return 'wranglerTypes';
  if (genI18nTsSegmentPattern.test(normalized)) return 'genI18nTs';
  // A one-level wrapper lookup covers `"postinstall": "bun run gen-types"`, the shape these repositories use;
  // deeper chains stay custom so wbfy cannot loop on a self-referential script.
  const scriptName = followsWrapper ? scriptRunnerPattern.exec(normalized)?.[1] : undefined;
  const target = scriptName === undefined ? undefined : scripts[scriptName];
  if (!target) return 'custom';
  const segments = splitScriptSegments(target);
  // A wrapper around a CUSTOMIZED gen-code (`bun wb gen-code && bun run build-assets`) still performs the managed
  // generation, so it counts as gen-code; treating it as custom would append a second `wb gen-code` and run every
  // generator twice per install.
  if (segments?.length !== 1) {
    // A wrapper around a CUSTOMIZED gen-code (`bun wb gen-code && bun run build-assets`) already performs the
    // managed generation AND the project's own steps, so it is the install-time entry point: it must be kept as
    // written. Replacing it with a bare `wb gen-code` would drop those steps; appending one would run every
    // generator twice.
    return segments?.some((inner) => genCodeSegmentPattern.test(inner.trim().replaceAll(/\s+/gu, ' ')))
      ? 'genCodeWrapper'
      : 'custom';
  }
  return classifyScriptSegment(segments[0] ?? '', scripts, false);
}

/**
 * Tells whether a script (re)generates worker-configuration.d.ts through the managed `wb gen-code`.
 */
export function runsManagedGenCode(script: string | undefined, scripts: PackageJson.Scripts): boolean {
  if (!script) return false;
  const segments = splitScriptSegments(script);
  return !!segments?.some((segment) => {
    const kind = classifyScriptSegment(segment, scripts);
    return kind === 'genCode' || kind === 'genCodeWrapper';
  });
}

/**
 * Whether any of the package's scripts runs a `wrangler types` that would produce a DIFFERENT file from the bare
 * one `wb gen-code` runs. Managing such a package would overwrite its intended output and delete the only record
 * of the choice, so wbfy leaves the whole package alone instead.
 *
 * Non-generating modes (`--check`, `--help`) are excluded: they validate or print and write nothing, so they
 * cannot conflict — and treating them as conflicts would strip the managed setup from a package that only
 * happens to keep a freshness check around.
 */
export function hasCustomWranglerTypesInvocation(scripts: PackageJson.Scripts): boolean {
  return Object.values(scripts).some((script) => {
    if (!script || !anyWranglerTypesPattern.test(script)) return false;
    const segments = splitScriptSegments(script);
    // An unparseable script containing `wrangler types` is treated as custom: wbfy cannot prove it is the plain
    // invocation, and guessing wrong silently replaces the project's generated types.
    if (!segments) return true;
    return segments.some((segment) => {
      const normalized = segment.trim().replaceAll(/\s+/gu, ' ');
      if (!anyWranglerTypesPattern.test(normalized)) return false;
      if (isNonConflictingWranglerTypes(normalized)) return false;
      return !isDisposableWranglerTypes(normalized);
    });
  });
}

/**
 * Whether an UNPARSEABLE script names nothing but generation `wb gen-code` already performs. These are legacy
 * wbfy shapes carrying redirections and empty segments; normalizing them loses nothing. A script mixing in a
 * project's own command (e.g. `patch-package > /dev/null && gen-i18n-ts`) must NOT match — the parser cannot
 * preserve that command, so the script has to be left alone instead of silently losing it.
 */
export function runsOnlyRedundantGeneration(script: string | undefined): boolean {
  return (
    splitRedundantCommands(script)?.every(
      (command) => genI18nTsSegmentPattern.test(command) || genCodeSegmentPattern.test(command)
    ) === true
  );
}

/**
 * The narrower case: EVERY command is an argument-free `gen-i18n-ts`, and none is `wb gen-code`. Only then can
 * the script be deleted outright — `wb gen-code` also runs prisma, drizzle-kit check, and chakra typegen, so
 * removing it would silently stop those even when the worker-types generation is no longer wanted.
 */
export function runsOnlyRedundantI18nGeneration(script: string | undefined): boolean {
  const commands = splitRedundantCommands(script);
  return commands !== undefined && commands.every((command) => genI18nTsSegmentPattern.test(command));
}

function splitRedundantCommands(script: string | undefined): string[] | undefined {
  if (!script) return undefined;
  const commands = script
    // The redirection TARGET only: shell control operators need no surrounding whitespace, so `\S+`
    // would swallow `&&touch` and make a project command vanish from the script.
    .replaceAll(/\s*>\s*[^\s;&|<>]+/gu, '')
    .split(/&&|;/u)
    .map((command) => command.trim().replaceAll(/\s+/gu, ' '))
    .filter(Boolean);
  return commands.length > 0 ? commands : undefined;
}
