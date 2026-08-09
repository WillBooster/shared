import type { PackageJson } from 'type-fest';

/**
 * Recognizes the managed `wb gen-code` segment, a one-level package-script wrapper around it, and
 * custom segments that wbfy leaves alone.
 */
type ScriptSegmentKind = 'custom' | 'genCode' | 'genCodeWrapper';

const genCodeSegmentPattern = /^(?:(?:bun|bunx)\s+)?(?:run\s+)?wb\s+gen-code$/u;

// A runner delegating to one of this package's own scripts, e.g. `bun run gen-types`.
const scriptRunnerPattern = /^(?:bun|bunx)\s+(?:run\s+)?(\S+)$/u;

// Anything wbfy's `&&` split cannot model (pipes, sequencing, redirections, quoting, substitutions, directory
// changes). Scripts containing it are left untouched instead of being rewritten from a wrong parse.
const unsupportedShellSyntaxPattern = /[\n;|<>`$'"()]|\bcd\s/u;

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
