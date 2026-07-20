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
  // Scanned over the context-free segments: an invocation after a real `cd` writes another directory's file
  // and must not disable management of this package.
  const conflicting = scriptValues.some(
    (script) =>
      contextFreeCommandSegments(script).some((segment) => {
        const invocationArgs = parseWranglerTypesInvocation(segment);
        if (invocationArgs) return classifyWranglerTypesInvocation(invocationArgs) === 'defaultOutputConflict';
        return isUnmodeledWranglerTypesSegment(segment, scripts);
      }) || hasNonTransplantableGeneratorPipeline(script, scripts)
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

/**
 * Whether the script pairs a reusable generator with prerequisite segments the managed scripts could not
 * transplant (e.g. `node scripts/prepare.js && wrangler types --strict-vars=false`): reusing only the generator
 * segment would bypass the prerequisites in gen-code and on fresh installs, so such packages stay unmanaged.
 */
function hasNonTransplantableGeneratorPipeline(script: string, scripts: PackageJson.Scripts): boolean {
  const segments = contextFreeCommandSegments(script);
  // Bare generators and wrapper-reached generators form pipelines too: a preparation step that creates
  // .dev.vars before `wrangler types` must not be bypassed either. A generator reached only through a
  // managed gen-code segment does not count: its pipeline is exactly what the managed scripts run, so a
  // composition like `yarn run gen-code && vite build` bypasses nothing — treating it as a pipeline would
  // (idempotency-breakingly) disable management right after wbfy itself appended the generator to gen-code.
  const hasReusableGenerator = segments.some(
    (segment) =>
      !isManagedGenCodeSegment(segment, scripts) &&
      reachesWranglerTypes(
        segment,
        scripts,
        (invocationArgs) => classifyWranglerTypesInvocation(invocationArgs) === 'reusableGenerator'
      )
  );
  if (!hasReusableGenerator) return false;
  return segments.some(
    (segment) =>
      segment !== '' &&
      !isManagedGenCodeSegment(segment, scripts) &&
      !parseWranglerTypesInvocation(segment) &&
      !reachesWranglerTypes(segment, scripts, () => true)
  );
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
        // Without the trailing comment: a reused `... # note` would swallow anything composed after it.
        segments.push(stripTrailingComment(segment));
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
      // A runner directed at another package (e.g. `bun run --filter components gen`) runs that package's
      // script, not one of these; forwarded arguments (`bun run gen-types -- --check`) change the effective
      // invocation, so the wrapper cannot stand for the plain script either.
      invokedScriptName =
        runnerFlags.leavesPackage || tokens.length > runnerFlags.index + 1 ? undefined : tokens[runnerFlags.index];
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
export function splitCommandSegments(script: string): string[] {
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
  let targetIndex = skipEnvironmentAssignments(tokens) + 1;
  if (tokens[targetIndex] === '--') targetIndex++;
  // Normalize static spellings of the current directory (`.`, `./`, `./.`, `././`, ...); anything else
  // (including a bare `cd`, which goes to $HOME) counts as a real directory change.
  let target = unquoteShellToken(tokens[targetIndex] ?? '');
  while (target.startsWith('./')) target = target.slice(2);
  if (target.endsWith('/')) target = target.slice(0, -1);
  return target === '.' && targetIndex + 1 === tokens.length;
}

/** Whether the segment just runs the managed code generation (`wb gen-code`, or a runner wrapper of gen-code). */
export function isManagedGenCodeSegment(segment: string, scripts: PackageJson.Scripts): boolean {
  const tokens = tokenizeCommandSegment(segment);
  let index = skipEnvironmentAssignments(tokens);
  let isRunSubcommand = false;
  if (scriptRunnerCommands.has(tokens[index] ?? '')) {
    index++;
    let runnerFlags = consumeRunnerFlags(tokens, index);
    if (['run', 'run-script', 'exec', 'dlx', 'x'].includes(tokens[runnerFlags.index] ?? '')) {
      isRunSubcommand = ['run', 'run-script'].includes(tokens[runnerFlags.index] ?? '');
      runnerFlags = consumeRunnerFlags(tokens, runnerFlags.index + 1, runnerFlags.leavesPackage);
    }
    if (runnerFlags.leavesPackage) return false;
    index = runnerFlags.index;
  }
  // Exact match only: `wb gen-code ; wrangler types --config ...` or `wb gen-code --flag` is not the plain
  // managed invocation and must not be discarded as one. After `run`/`run-script` only a package-script name
  // follows, so `npm run wb gen-code` invokes the script called `wb`, not the wb binary.
  if (!isRunSubcommand && tokens[index] === 'wb' && tokens[index + 1] === 'gen-code') {
    return index + 2 === tokens.length;
  }
  if (tokens[index] !== 'gen-code' || index + 1 !== tokens.length) return false;
  // A gen-code wrapper is interchangeable with `wb gen-code` only when the gen-code script itself is the
  // managed pipeline (`wb gen-code` plus reusable managed generation); a custom pipeline behind it (e.g.
  // `node scripts/prepareTypes.js && wrangler types ...` or a custom-config invocation) must be preserved
  // instead of being replaced by the bare wb command.
  const genCodeScript = scripts['gen-code'];
  return (
    typeof genCodeScript === 'string' &&
    contextFreeCommandSegments(genCodeScript).every((genCodeSegment) => {
      if (genCodeSegment === '') return true;
      const genCodeTokens = tokenizeCommandSegment(genCodeSegment);
      let genCodeIndex = skipEnvironmentAssignments(genCodeTokens);
      if (scriptRunnerCommands.has(genCodeTokens[genCodeIndex] ?? '')) genCodeIndex++;
      if (genCodeTokens[genCodeIndex] === 'wb' && genCodeTokens[genCodeIndex + 1] === 'gen-code') return true;
      const invocationArgs = parseWranglerTypesInvocation(genCodeSegment);
      return !!invocationArgs && classifyWranglerTypesInvocation(invocationArgs) === 'reusableGenerator';
    })
  );
}

/** Whether the script textually mentions `wrangler types` outside quotes, whatever its shell form. */
export function mentionsWranglerTypes(script: string): boolean {
  return /\bwrangler\s+types\b/u.test(stripQuotedSpans(script));
}

/**
 * Whether the segment involves `wrangler types` in a shell form the parser cannot faithfully model: an unquoted
 * mention that does not parse as an invocation (a subshell, a non-local runner, arbitrary shell syntax), a
 * syntactically quoted command word (`"wrangler" types` executes wrangler but evades tokenization), or a wrapper
 * forwarding extra arguments (`npm run gen-types -- --check`) whose target involves `wrangler types` — the
 * forwarded arguments change the effective invocation. Such segments make the package unmanageable and must be
 * preserved verbatim wherever wbfy rewrites scripts.
 */
export function isUnmodeledWranglerTypesSegment(
  segment: string,
  scripts: PackageJson.Scripts,
  visitedScriptNames = new Set<string>()
): boolean {
  if (parseWranglerTypesInvocation(segment)) return false;
  if (mentionsWranglerTypes(segment)) return true;
  if (/["']wrangler["']\s+types\b|\bwrangler\s+["']types["']/u.test(segment)) return true;
  // Double quotes do not suppress command substitution: `echo "$(wrangler types ...)"` executes wrangler.
  if (/\$\(|`/u.test(stripSingleQuotedSpans(segment)) && /\bwrangler\s+types\b/u.test(segment)) return true;
  // Global options may precede the subcommand (`wrangler --config alternate.jsonc types`); any unparsed
  // segment carrying both words cannot be classified.
  const unquotedTokens = new Set(tokenizeCommandSegment(segment).map((token) => unquoteShellToken(token)));
  if (unquotedTokens.has('wrangler') && unquotedTokens.has('types')) return true;
  const tokens = tokenizeCommandSegment(segment);
  let index = skipEnvironmentAssignments(tokens);
  if (!scriptWrapperRunnerCommands.has(tokens[index] ?? '')) return false;
  index++;
  let runnerFlags = consumeRunnerFlags(tokens, index);
  if (['run', 'run-script'].includes(tokens[runnerFlags.index] ?? '')) {
    runnerFlags = consumeRunnerFlags(tokens, runnerFlags.index + 1, runnerFlags.leavesPackage);
  }
  const invokedScriptName = tokens[runnerFlags.index];
  const forwardsArguments = tokens.length > runnerFlags.index + 1;
  if (runnerFlags.leavesPackage || !invokedScriptName) return false;
  if (visitedScriptNames.has(invokedScriptName)) return false;
  visitedScriptNames.add(invokedScriptName);
  const invokedScript = scripts[invokedScriptName];
  if (typeof invokedScript !== 'string') return false;
  // A plain wrapper of an unmodeled target is itself unmodeled; a wrapper forwarding arguments additionally
  // changes any modeled target's effective invocation, so reaching one taints it too.
  return (
    splitCommandSegments(invokedScript).some((invokedSegment) =>
      isUnmodeledWranglerTypesSegment(invokedSegment, scripts, visitedScriptNames)
    ) ||
    (forwardsArguments && reachesWranglerTypes(invokedScript, scripts, () => true, new Set(visitedScriptNames)))
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

/** Remove only single-quoted spans: double quotes do not suppress command substitution (`$()`, backticks). */
function stripSingleQuotedSpans(script: string): string {
  let result = '';
  let inSingleQuote = false;
  for (const character of script) {
    if (inSingleQuote) {
      if (character === "'") inSingleQuote = false;
      continue;
    }
    if (character === "'") {
      inSingleQuote = true;
      continue;
    }
    result += character;
  }
  return result;
}

/** Remove shell quote delimiters, keeping their content: `'--config'` has the argument value --config. */
function unquoteShellToken(token: string): string {
  let result = '';
  let quote: string | undefined;
  for (let index = 0; index < token.length; index++) {
    const character = token[index] ?? '';
    if (quote) {
      if (character === '\\' && quote === '"') {
        result += token[++index] ?? '';
        continue;
      }
      if (character === quote) quote = undefined;
      else result += character;
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

/** Cut a trailing unquoted shell comment so composing further commands after the segment stays executable. */
function stripTrailingComment(segment: string): string {
  let quote: string | undefined;
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index] ?? '';
    if (quote) {
      if (character === '\\' && quote === '"') index++;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/u.test(segment[index - 1] ?? ''))) {
      return segment.slice(0, index).trim();
    }
  }
  return segment;
}

/**
 * Parse a command segment as a `wrangler types` invocation and return its arguments (with shell redirections
 * stripped), or undefined when the segment runs something else. Requiring command position (after environment
 * assignments and a runner prefix with its flags, e.g. `npx --yes`) keeps shell text that merely mentions the
 * words (e.g. `echo wrangler types`) from being treated as a generator.
 */
export function parseWranglerTypesInvocation(segment: string): string[] | undefined {
  // An unquoted newline separates commands the segment splitter does not model.
  if (stripQuotedSpans(segment).includes('\n')) return;
  const tokens = tokenizeCommandSegment(segment);
  let index = skipEnvironmentAssignments(tokens);
  if (scriptRunnerCommands.has(tokens[index] ?? '')) {
    index++;
    let runnerFlags = consumeRunnerFlags(tokens, index);
    // `run`/`run-script` name a package script, never a binary: `bun run wrangler types` invokes the script
    // called `wrangler` with `types` as an argument, so it must go through wrapper resolution instead.
    if (['run', 'run-script'].includes(tokens[runnerFlags.index] ?? '')) return;
    if (['exec', 'dlx', 'x'].includes(tokens[runnerFlags.index] ?? '')) {
      runnerFlags = consumeRunnerFlags(tokens, runnerFlags.index + 1, runnerFlags.leavesPackage);
    }
    // A runner directed at another package runs that package's wrangler, not this one's.
    if (runnerFlags.leavesPackage) return;
    index = runnerFlags.index;
  }
  if (tokens[index] !== 'wrangler' || tokens[index + 1] !== 'types') return;

  const invocationArgs: string[] = [];
  for (let argIndex = index + 2; argIndex < tokens.length; argIndex++) {
    const token = tokens[argIndex] ?? '';
    // A token-initial unquoted `#` starts a shell comment: everything after it is not an argument.
    if (token.startsWith('#')) break;
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
    const rawArg = invocationArgs[index] ?? '';
    // Unquoted shell metacharacters (pipes, subshells, `;`, a backgrounding `&`) are not modeled by the
    // parser, and command substitution executes even inside double quotes; conservatively treat such
    // invocations as conflicting.
    if (/[();|`&]|\$\(/u.test(stripQuotedSpans(rawArg)) || /\$\(|`/u.test(stripSingleQuotedSpans(rawArg))) {
      return 'defaultOutputConflict';
    }
    // Shell quoting does not change an argument's value: `'--config'` is still --config.
    const arg = unquoteShellToken(rawArg);
    const nextArg = unquoteShellToken(invocationArgs[index + 1] ?? '');
    // Non-generating modes write no file at all, whatever other flags say. They are boolean options: only
    // their enabled forms suppress generation, while `--check=false` (or `--check 'false'`) still writes.
    if (/^(?:--help|-h|--version|-v)(?:=true)?$/u.test(arg) && nextArg !== 'false') return 'harmless';
    if (/^--check(?:=true)?$/u.test(arg) && nextArg !== 'false') return 'harmless';
    if (/^(?:--config|-c|--env|-e|--env-file)(?:=.*)?$/u.test(arg)) {
      changesInputs = true;
      if (!arg.includes('=')) index++;
      continue;
    }
    if (/^--cwd(?:=.*)?$/u.test(arg)) {
      // `--cwd .` still runs in this package's directory, so it stays an ordinary local invocation.
      const cwdValue = arg.includes('=')
        ? arg.slice('--cwd='.length)
        : unquoteShellToken(invocationArgs[++index] ?? '');
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
      if (nextArg === 'true' || nextArg === 'false') index++;
      continue;
    }
    let outputPath = arg;
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

// Runner options consuming the following token as their value; skipping that value too keeps the
// command word (e.g. the wrapped script name) findable. The directory-changing ones run the
// command in another package when the value is not this one, and the workspace/filter selectors
// always do — wbfy generates `bun run --filter <pkg> <script>` itself, so a runner that leaves the
// package must not resolve the script name against THIS package's scripts.
const runnerDirectoryValueFlags = new Set(['--cwd', '-C', '--prefix', '--dir']);
const runnerWorkspaceValueFlags = new Set(['-w', '--workspace', '-F', '--filter']);
// Bare selectors that run the command in every workspace instead of (only) this package.
const runnerAllWorkspacesFlags = new Set(['--workspaces', '-ws', '--recursive', '-r']);

/** Skips the runner's own options (e.g. `bunx --yes wrangler types`) to reach the command word. */
function consumeRunnerFlags(
  tokens: string[],
  index: number,
  leavesPackage = false
): { index: number; leavesPackage: boolean } {
  while ((tokens[index] ?? '').startsWith('-')) {
    const flag = tokens[index] ?? '';
    index++;
    let directoryValue: string | undefined;
    if (runnerDirectoryValueFlags.has(flag)) {
      directoryValue = tokens[index];
      index++;
    } else if (/^(?:--cwd|--prefix|--dir)=/u.test(flag)) {
      directoryValue = flag.slice(flag.indexOf('=') + 1);
    } else if (runnerWorkspaceValueFlags.has(flag)) {
      index++;
      leavesPackage = true;
    } else if (/^(?:-w|--workspace|-F|--filter)=/u.test(flag) || runnerAllWorkspacesFlags.has(flag)) {
      leavesPackage = true;
    }
    if (directoryValue !== undefined && directoryValue !== '.' && directoryValue !== './') leavesPackage = true;
  }
  return { index, leavesPackage };
}
