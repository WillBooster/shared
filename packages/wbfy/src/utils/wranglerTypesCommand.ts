import type { PackageJson } from 'type-fest';

/**
 * How a `wrangler types` invocation relates to the default ./worker-configuration.d.ts that wbfy manages:
 * - `reusableGenerator`: regenerates the managed file from the inputs the management gate validated, so it can serve
 *   as the shared generator command.
 * - `defaultOutputConflict`: writes the managed file from inputs the gate cannot validate (`--config`, `--env`,
 *   `--env-file`), so a managed fallback generator would fight it over the same file — wbfy must not manage the
 *   package at all.
 * - `harmless`: generates nothing (`--check`, `--help`, `--version`) or writes another file (`--cwd`, a custom
 *   positional output path), so it can coexist with the managed generator.
 */
export type WranglerTypesInvocationKind = 'reusableGenerator' | 'defaultOutputConflict' | 'harmless';

const scriptRunnerCommands = new Set(['yarn', 'bun', 'npm', 'pnpm', 'bunx', 'npx']);
const scriptWrapperRunnerCommands = new Set(['yarn', 'bun', 'npm', 'pnpm']);
// Flags of `wrangler types` that consume the following token as their value; unknown separate-value flags make
// their value look positional, which safely disqualifies the invocation instead of misreading its output path.
const wranglerTypesValueFlags = new Set(['--env-interface']);

/**
 * Whether wbfy can manage worker-configuration.d.ts for these scripts, and with which project-specific generator
 * command. `conflicting` is true when a script writes the managed default file from inputs the management gate
 * cannot validate (e.g. `wrangler types -c wrangler.jsonc -c ../bound-worker/wrangler.jsonc` for RPC types — a
 * managed fallback generator would overwrite that richer output), or when several distinct flagged generators
 * exist in the preferred script with no way to choose one deterministically. `command` is the single flagged
 * generator to reuse, preferring what postinstall already runs (that is what shapes the file after every
 * install), then gen-code, then any other script; undefined means the managed default command applies.
 */
export function selectProjectWranglerTypesGenerator(scripts: PackageJson.Scripts): {
  conflicting: boolean;
  command: string | undefined;
} {
  const scriptValues = Object.values(scripts).filter((script): script is string => typeof script === 'string');
  const conflicting = scriptValues.some((script) =>
    splitCommandSegments(script).some((segment) => {
      const invocationArgs = parseWranglerTypesInvocation(segment);
      if (invocationArgs) return classifyWranglerTypesInvocation(invocationArgs) === 'defaultOutputConflict';
      // An unquoted `wrangler types` mention the parser cannot model (a subshell like `(wrangler types ...)`,
      // a non-local runner directory, arbitrary whitespace) cannot be classified — splitting such constructs
      // apart would fabricate malformed commands, so the package stays unmanaged.
      return /\bwrangler\s+types\b/u.test(stripQuotedSpans(segment));
    })
  );
  const preferredCandidates = [
    collectReusableGeneratorSegments(scripts.postinstall, scripts),
    collectReusableGeneratorSegments(scripts['gen-code'], scripts),
    scriptValues.flatMap((script) => collectReusableGeneratorSegments(script, scripts)),
  ].find((candidates) => candidates.length > 0);
  // Normalized only as the deduplication key: rewriting whitespace in the command itself would change quoted
  // values (e.g. a redirection target with doubled spaces).
  const distinctCommands = new Map<string, string>();
  for (const segment of preferredCandidates ?? []) {
    const key = tokenizeCommandSegment(segment).join(' ');
    if (!distinctCommands.has(key)) distinctCommands.set(key, segment);
  }
  return {
    conflicting: conflicting || distinctCommands.size > 1,
    command: distinctCommands.size === 1 ? [...distinctCommands.values()][0] : undefined,
  };
}

/** The flagged reusable-generator segments the script reaches, directly or through wrapper scripts. */
function collectReusableGeneratorSegments(
  script: string | undefined,
  scripts: PackageJson.Scripts,
  visitedScriptNames = new Set<string>()
): string[] {
  const segments: string[] = [];
  if (!script) return segments;
  reachesWranglerTypes(
    script,
    scripts,
    (invocationArgs, segment) => {
      if (invocationArgs.length > 0 && classifyWranglerTypesInvocation(invocationArgs) === 'reusableGenerator') {
        segments.push(segment);
      }
      return false; // keep collecting instead of stopping at the first match
    },
    visitedScriptNames
  );
  return segments;
}

/**
 * Whether the package's install pipeline regenerates the managed worker-configuration.d.ts, directly or through
 * wrapper scripts. Untracking the file is safe only when this holds for the final generated scripts.
 */
export function postinstallGeneratesWorkerTypes(scripts: PackageJson.Scripts): boolean {
  return reachesWranglerTypes(
    scripts.postinstall,
    scripts,
    (invocationArgs) => classifyWranglerTypesInvocation(invocationArgs) === 'reusableGenerator'
  );
}

/**
 * Whether the script reaches a `wrangler types` invocation satisfying the predicate, directly or through the
 * package scripts it invokes (e.g. `"postinstall": "yarn gen:types"`, with runner flags and environment
 * assignments allowed around the script name).
 */
export function reachesWranglerTypes(
  script: string | undefined,
  scripts: PackageJson.Scripts,
  predicate: (invocationArgs: string[], segment: string) => boolean,
  visitedScriptNames = new Set<string>()
): boolean {
  if (!script) return false;
  for (const segment of contextFreeCommandSegments(script)) {
    const invocationArgs = parseWranglerTypesInvocation(segment);
    if (invocationArgs && predicate(invocationArgs, segment)) return true;
    const tokens = tokenizeCommandSegment(segment);
    let index = skipEnvironmentAssignments(tokens);
    let invokedScriptName: string | undefined;
    if (scriptWrapperRunnerCommands.has(tokens[index] ?? '')) {
      index++;
      let runnerFlags = consumeRunnerFlags(tokens, index);
      if (['run', 'run-script'].includes(tokens[runnerFlags.index] ?? '')) {
        runnerFlags = consumeRunnerFlags(tokens, runnerFlags.index + 1, runnerFlags.leavesPackage);
      }
      // A runner directed at another directory (e.g. `yarn --cwd ../other gen-types`) runs that package's
      // script, not one of these.
      invokedScriptName = runnerFlags.leavesPackage ? undefined : tokens[runnerFlags.index];
    }
    if (!invokedScriptName || visitedScriptNames.has(invokedScriptName)) continue;
    visitedScriptNames.add(invokedScriptName);
    const invokedScript = scripts[invokedScriptName];
    if (
      typeof invokedScript === 'string' &&
      reachesWranglerTypes(invokedScript, scripts, predicate, visitedScriptNames)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The command segments of a script that run in the package directory: segments after a `cd` (except literal
 * no-ops like `cd .`) execute somewhere else, so a `wrangler types` there generates another package's file, not
 * this one's, and must be invisible to every decision about the managed file.
 */
export function contextFreeCommandSegments(script: string): string[] {
  const segments: string[] = [];
  for (const segment of splitCommandSegments(script)) {
    if (isDirectoryChange(segment)) {
      if (isNoOpDirectoryChange(segment)) continue;
      break;
    }
    segments.push(segment);
  }
  return segments;
}

/** Whether the script leaves the package directory at some point (an appended command would then run elsewhere). */
export function scriptChangesWorkingDirectory(script: string): boolean {
  return splitCommandSegments(script).some((segment) => isDirectoryChange(segment) && !isNoOpDirectoryChange(segment));
}

/**
 * Split a shell command line on `&&` outside quotes: a quoted `&&` (e.g. `echo "setup && wrangler types ..."`)
 * is argument text, and splitting inside it would fabricate a command that was never run.
 */
function splitCommandSegments(script: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let index = 0; index < script.length; index++) {
    const character = script[index] ?? '';
    if (quote) {
      if (character === '\\' && quote === '"') {
        current += character + (script[++index] ?? '');
        continue;
      }
      if (character === quote) quote = undefined;
      current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '&' && script[index + 1] === '&') {
      segments.push(current.trim());
      current = '';
      index++;
      continue;
    }
    current += character;
  }
  segments.push(current.trim());
  return segments;
}

function isDirectoryChange(segment: string): boolean {
  const tokens = tokenizeCommandSegment(segment);
  return tokens[skipEnvironmentAssignments(tokens)] === 'cd';
}

function isNoOpDirectoryChange(segment: string): boolean {
  const tokens = tokenizeCommandSegment(segment);
  const target = (tokens[skipEnvironmentAssignments(tokens) + 1] ?? '').replaceAll(/^["']|["']$/gu, '');
  return target === '.' || target === './';
}

/** Whether the segment just runs the managed code generation (`wb gen-code`, or a runner wrapper of gen-code). */
export function isManagedGenCodeSegment(segment: string, scripts: PackageJson.Scripts): boolean {
  const tokens = tokenizeCommandSegment(segment);
  let index = skipEnvironmentAssignments(tokens);
  if (scriptRunnerCommands.has(tokens[index] ?? '')) {
    index++;
    let runnerFlags = consumeRunnerFlags(tokens, index);
    if (['run', 'run-script'].includes(tokens[runnerFlags.index] ?? '')) {
      runnerFlags = consumeRunnerFlags(tokens, runnerFlags.index + 1, runnerFlags.leavesPackage);
    }
    if (runnerFlags.leavesPackage) return false;
    index = runnerFlags.index;
  }
  if (tokens[index] === 'wb' && tokens[index + 1] === 'gen-code') return true;
  if (tokens[index] !== 'gen-code') return false;
  // A gen-code wrapper is interchangeable with `wb gen-code` only when the gen-code script itself is the
  // managed pipeline; a custom pipeline behind it (e.g. `node scripts/prepareTypes.js && wrangler types ...`)
  // must be preserved instead of being replaced by the bare wb command.
  const genCodeScript = scripts['gen-code'];
  return (
    typeof genCodeScript === 'string' &&
    contextFreeCommandSegments(genCodeScript).every((genCodeSegment) => {
      if (genCodeSegment === '') return true;
      const genCodeTokens = tokenizeCommandSegment(genCodeSegment);
      let genCodeIndex = skipEnvironmentAssignments(genCodeTokens);
      if (scriptRunnerCommands.has(genCodeTokens[genCodeIndex] ?? '')) genCodeIndex++;
      if (genCodeTokens[genCodeIndex] === 'wb' && genCodeTokens[genCodeIndex + 1] === 'gen-code') return true;
      return !!parseWranglerTypesInvocation(genCodeSegment);
    })
  );
}

/** Tokenize a command segment on whitespace outside quotes, so quoted values (e.g. `X="a b"`) stay one token. */
function tokenizeCommandSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index] ?? '';
    if (quote) {
      if (character === '\\' && quote === '"') {
        current += character + (segment[++index] ?? '');
        continue;
      }
      if (character === quote) quote = undefined;
      current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Remove quoted spans so shell metacharacters inside argument text are not mistaken for syntax. */
function stripQuotedSpans(script: string): string {
  let result = '';
  let quote: string | undefined;
  for (let index = 0; index < script.length; index++) {
    const character = script[index] ?? '';
    if (quote) {
      if (character === '\\' && quote === '"') index++;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    result += character;
  }
  return result;
}

/**
 * Parse a command segment as a `wrangler types` invocation and return its arguments (with shell redirections
 * stripped), or undefined when the segment runs something else. Requiring command position (after environment
 * assignments and a runner prefix with its flags, e.g. `npx --yes`) keeps shell text that merely mentions the
 * words (e.g. `echo wrangler types`) from being treated as a generator.
 */
export function parseWranglerTypesInvocation(segment: string): string[] | undefined {
  const tokens = tokenizeCommandSegment(segment);
  let index = skipEnvironmentAssignments(tokens);
  if (scriptRunnerCommands.has(tokens[index] ?? '')) {
    index++;
    let runnerFlags = consumeRunnerFlags(tokens, index);
    if (['run', 'run-script', 'exec', 'dlx', 'x'].includes(tokens[runnerFlags.index] ?? '')) {
      runnerFlags = consumeRunnerFlags(tokens, runnerFlags.index + 1, runnerFlags.leavesPackage);
    }
    // A runner directed at another directory runs that package's wrangler, not this one's.
    if (runnerFlags.leavesPackage) return;
    index = runnerFlags.index;
  }
  if (tokens[index] !== 'wrangler' || tokens[index + 1] !== 'types') return;

  const invocationArgs: string[] = [];
  for (let argIndex = index + 2; argIndex < tokens.length; argIndex++) {
    const token = tokens[argIndex] ?? '';
    // Shell redirections (`> /dev/null`, `2>&1`, `>>log`) are not wrangler arguments; a bare operator also
    // consumes the following token as its target.
    const redirectionOperator = /^(?:\d+|&)?(?:>>?|<)/u.exec(token)?.[0];
    if (redirectionOperator) {
      if (redirectionOperator === token) argIndex++;
      continue;
    }
    invocationArgs.push(token);
  }
  return invocationArgs;
}

/** Classify what the invocation writes; see WranglerTypesInvocationKind. */
export function classifyWranglerTypesInvocation(invocationArgs: string[]): WranglerTypesInvocationKind {
  let writesElsewhere = false;
  let changesInputs = false;
  for (let index = 0; index < invocationArgs.length; index++) {
    const arg = invocationArgs[index] ?? '';
    // Unquoted shell metacharacters (pipes, subshells, command substitution, `;`) are not modeled by the
    // parser, so the invocation cannot be classified; conservatively treat it as conflicting.
    if (/[();|`]|\$\(/u.test(stripQuotedSpans(arg))) return 'defaultOutputConflict';
    // Non-generating modes write no file at all, whatever other flags say. `--check` is a boolean option:
    // only its enabled forms suppress generation, while `--check=false` (or `--check false`) still writes.
    if (/^(?:--help|-h|--version|-v)(?:=.*)?$/u.test(arg)) return 'harmless';
    if (/^--check(?:=true)?$/u.test(arg) && invocationArgs[index + 1] !== 'false') return 'harmless';
    if (/^(?:--config|-c|--env|-e|--env-file)(?:=.*)?$/u.test(arg)) {
      changesInputs = true;
      if (!arg.includes('=')) index++;
      continue;
    }
    if (/^--cwd(?:=.*)?$/u.test(arg)) {
      // `--cwd .` still runs in this package's directory, so it stays an ordinary local invocation.
      const cwdValue = arg.includes('=') ? arg.slice('--cwd='.length) : (invocationArgs[++index] ?? '');
      if (cwdValue !== '.' && cwdValue !== './') writesElsewhere = true;
      continue;
    }
    if (wranglerTypesValueFlags.has(arg)) {
      index++;
      continue;
    }
    if (arg.startsWith('-')) {
      // Boolean options accept a space-separated literal (e.g. `--strict-vars false`), which must not be
      // misread as a positional output path.
      if (invocationArgs[index + 1] === 'true' || invocationArgs[index + 1] === 'false') index++;
      continue;
    }
    let outputPath = arg.replaceAll(/^["']|["']$/gu, '');
    while (outputPath.startsWith('./')) outputPath = outputPath.slice(2);
    if (outputPath !== 'worker-configuration.d.ts') writesElsewhere = true;
  }
  if (writesElsewhere) return 'harmless';
  if (changesInputs) return 'defaultOutputConflict';
  return 'reusableGenerator';
}

function skipEnvironmentAssignments(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? '')) index++;
  return index;
}

// Runner options that consume the following token as their value; the directory-changing ones make the runner
// operate on another package when the value is not the package itself.
const runnerValueFlags = new Set(['--cwd', '-C', '--prefix', '--dir']);

function consumeRunnerFlags(
  tokens: string[],
  index: number,
  leavesPackage = false
): { index: number; leavesPackage: boolean } {
  while ((tokens[index] ?? '').startsWith('-')) {
    const flag = tokens[index] ?? '';
    index++;
    let directoryValue: string | undefined;
    if (runnerValueFlags.has(flag)) {
      directoryValue = tokens[index];
      index++;
    } else if (/^(?:--cwd|--prefix|--dir)=/u.test(flag)) {
      directoryValue = flag.slice(flag.indexOf('=') + 1);
    }
    if (directoryValue !== undefined && directoryValue !== '.' && directoryValue !== './') leavesPackage = true;
  }
  return { index, leavesPackage };
}
