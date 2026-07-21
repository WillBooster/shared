import fs from 'node:fs';
import path from 'node:path';

import type { PackageJson } from 'type-fest';

/**
 * `wb gen-code` runs `wrangler types` as its first step, so wbfy no longer has to model arbitrary shells to keep
 * worker-configuration.d.ts generated. It only needs to recognize the two segments it owns — the managed
 * `wb gen-code` and a plain `wrangler types` invocation — and to leave everything else alone.
 */
export type ScriptSegmentKind = 'custom' | 'genCode' | 'genCodeWrapper' | 'genI18nTs' | 'wranglerTypes';

// Runner spellings wbfy has generated over time (`wb gen-code`, `bun wb gen-code`) plus wrappers around the
// package's own `gen-code` script.
const genCodeSegmentPattern = /^(?:(?:bun|bunx|yarn|pnpm|npm)\s+)?(?:run\s+)?wb\s+gen-code$/u;

// A bare `wrangler types`, which is exactly what `wb gen-code` runs.
const bareWranglerTypesPattern = /^(?:(?:bunx|npx)\s+|(?:yarn|pnpm)\s+dlx\s+)?wrangler\s+types$/u;

// The same, plus only `--env-file` arguments. The flag names the files wrangler reads to infer local variables
// and secrets, so it changes the generated `Env` WHENEVER A NAMED FILE EXISTS — dropping it would then shrink
// the declaration. It is disposable only once every named file is gone, which is the state fnox migration leaves
// behind (the `.env` cascade is deleted) and the case this normalization is for.
const envFileWranglerTypesPattern =
  /^(?:(?:bunx|npx)\s+|(?:yarn|pnpm)\s+dlx\s+)?wrangler\s+types(?:\s+--env-file\s+(\S+))+$/u;
const envFileArgumentPattern = /--env-file\s+(\S+)/gu;

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
function isNonConflictingWranglerTypes(segment: string, dirPath: string | undefined): boolean {
  if (helpFlagPattern.test(segment)) return true;
  if (!checkFlagPattern.test(segment)) return false;
  return isDisposableWranglerTypes(segment.replace(checkFlagPattern, ' ').replaceAll(/\s+/gu, ' ').trim(), dirPath);
}

/** Whether every file the segment's `--env-file` arguments name is absent, so dropping the flag changes nothing. */
function namesOnlyMissingEnvFiles(segment: string, dirPath: string | undefined): boolean {
  const matches = [...segment.matchAll(envFileArgumentPattern)].map((match) => match[1]);
  if (matches.length === 0) return true;
  // Without a directory to resolve against, assume the files exist: keeping a flag is recoverable, silently
  // regenerating a smaller `Env` is not.
  if (dirPath === undefined) return false;
  return matches.every(
    (relativePath) => relativePath !== undefined && !fs.existsSync(path.resolve(dirPath, relativePath))
  );
}

/** Whether the segment is a `wrangler types` invocation equivalent to the bare one `wb gen-code` runs. */
function isDisposableWranglerTypes(segment: string, dirPath: string | undefined): boolean {
  if (bareWranglerTypesPattern.test(segment)) return true;
  return envFileWranglerTypesPattern.test(segment) && namesOnlyMissingEnvFiles(segment, dirPath);
}

// `wb gen-code` runs gen-i18n-ts itself, so a postinstall still invoking it (the script or the binary) is
// redundant rather than a project-specific step worth preserving.
const genI18nTsSegmentPattern = /^(?:(?:bun|bunx|yarn|pnpm|npm)\s+)?(?:run\s+)?gen-i18n-ts(?:\s|$)/u;

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
  followsWrapper = true,
  dirPath?: string
): ScriptSegmentKind {
  const normalized = segment.trim().replaceAll(/\s+/gu, ' ');
  if (genCodeSegmentPattern.test(normalized)) return 'genCode';
  if (isDisposableWranglerTypes(normalized, dirPath)) return 'wranglerTypes';
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
  return classifyScriptSegment(segments[0] ?? '', scripts, false, dirPath);
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
export function hasCustomWranglerTypesInvocation(scripts: PackageJson.Scripts, dirPath?: string): boolean {
  return Object.values(scripts).some((script) => {
    if (!script || !anyWranglerTypesPattern.test(script)) return false;
    const segments = splitScriptSegments(script);
    // An unparseable script containing `wrangler types` is treated as custom: wbfy cannot prove it is the plain
    // invocation, and guessing wrong silently replaces the project's generated types.
    if (!segments) return true;
    return segments.some((segment) => {
      const normalized = segment.trim().replaceAll(/\s+/gu, ' ');
      if (!anyWranglerTypesPattern.test(normalized)) return false;
      if (isNonConflictingWranglerTypes(normalized, dirPath)) return false;
      return !isDisposableWranglerTypes(normalized, dirPath);
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
  if (!script) return false;
  const commands = script
    .replaceAll(/\s*>\s*\S+/gu, '')
    .split(/&&|;/u)
    .map((command) => command.trim().replaceAll(/\s+/gu, ' '))
    .filter(Boolean);
  return (
    commands.length > 0 &&
    commands.every((command) => genI18nTsSegmentPattern.test(command) || genCodeSegmentPattern.test(command))
  );
}
