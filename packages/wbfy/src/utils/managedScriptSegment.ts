import type { PackageJson } from 'type-fest';

/**
 * `wb gen-code` runs `wrangler types` as its first step, so wbfy no longer has to model arbitrary shells to keep
 * worker-configuration.d.ts generated. It only needs to recognize the two segments it owns — the managed
 * `wb gen-code` and a plain `wrangler types` invocation — and to leave everything else alone.
 */
export type ScriptSegmentKind = 'custom' | 'genCode' | 'genI18nTs' | 'wranglerTypes';

// Runner spellings wbfy has generated over time (`wb gen-code`, `bun wb gen-code`) plus wrappers around the
// package's own `gen-code` script.
const genCodeSegmentPattern = /^(?:(?:bun|bunx|yarn|pnpm|npm)\s+)?(?:run\s+)?wb\s+gen-code$/u;

// `wrangler types` spellings wbfy drops: bare, and `--env-file` (a legacy `.env` idiom — these repositories read
// environment variables through fnox, so the flag only names a file that no longer exists). Every OTHER flag
// changes what the generated file contains — `--strict-vars=false` widens `vars` from literal unions to string,
// repeated `-c/--config` pulls in service-binding and Durable Object RPC types, `--path` moves the output — so
// such an invocation is semantically significant and must survive; see isCustomWranglerTypesInvocation.
const wranglerTypesSegmentPattern =
  /^(?:(?:bunx|npx)\s+|(?:yarn|pnpm)\s+dlx\s+)?wrangler\s+types(?:\s+--env-file\s+\S+)*$/u;

// Any `wrangler types` invocation, whatever its flags.
const anyWranglerTypesPattern = /(?:^|\s)wrangler\s+types(?:\s|$)/u;

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
  followsWrapper = true
): ScriptSegmentKind {
  const normalized = segment.trim().replaceAll(/\s+/gu, ' ');
  if (genCodeSegmentPattern.test(normalized)) return 'genCode';
  if (wranglerTypesSegmentPattern.test(normalized)) return 'wranglerTypes';
  if (genI18nTsSegmentPattern.test(normalized)) return 'genI18nTs';
  // A one-level wrapper lookup covers `"postinstall": "bun run gen-types"`, the shape these repositories use;
  // deeper chains stay custom so wbfy cannot loop on a self-referential script.
  const scriptName = followsWrapper ? scriptRunnerPattern.exec(normalized)?.[1] : undefined;
  const target = scriptName === undefined ? undefined : scripts[scriptName];
  if (!target) return 'custom';
  const segments = splitScriptSegments(target);
  if (segments?.length !== 1) return 'custom';
  return classifyScriptSegment(segments[0] ?? '', scripts, false);
}

/**
 * Tells whether a script (re)generates worker-configuration.d.ts through the managed `wb gen-code`.
 */
export function runsManagedGenCode(script: string | undefined, scripts: PackageJson.Scripts): boolean {
  if (!script) return false;
  const segments = splitScriptSegments(script);
  return !!segments?.some((segment) => classifyScriptSegment(segment, scripts) === 'genCode');
}

/**
 * Whether any of the package's scripts runs a `wrangler types` whose flags change the generated file (anything
 * beyond `--env-file`). `wb gen-code` runs a bare `wrangler types`, so managing such a package would overwrite
 * its intended output with the default one — wbfy leaves the whole package alone instead.
 */
export function hasCustomWranglerTypesInvocation(scripts: PackageJson.Scripts): boolean {
  return Object.values(scripts).some((script) => {
    if (!script || !anyWranglerTypesPattern.test(script)) return false;
    const segments = splitScriptSegments(script);
    // An unparseable script containing `wrangler types` is treated as custom: wbfy cannot prove it is the plain
    // invocation, and guessing wrong silently replaces the project's generated types.
    if (!segments) return true;
    return segments.some(
      (segment) =>
        anyWranglerTypesPattern.test(segment) &&
        !wranglerTypesSegmentPattern.test(segment.trim().replaceAll(/\s+/gu, ' '))
    );
  });
}
