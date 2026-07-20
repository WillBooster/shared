import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import fg from 'fast-glob';
import semver from 'semver';
import { sortPackageJson } from 'sort-package-json';
import * as ast from 'typescript/unstable/ast';
import type { PackageJson, SetRequired } from 'type-fest';

import { getLatestCommitHash } from '../github/commit.js';
import { logger } from '../logger.js';
import { consumesGeneratedWorkerTypes, generatesWorkerTypes, type PackageConfig } from '../packageConfig.js';
import {
  classifyWranglerTypesInvocation,
  isManagedGenCodeSegment,
  isUnmodeledWranglerTypesSegment,
  parseWranglerTypesInvocation,
  postinstallGeneratesWorkerTypes,
  reachesWranglerTypes,
  scriptChangesWorkingDirectory,
  selectProjectWranglerTypesGenerator,
  splitCommandSegments,
} from '../utils/wranglerTypesCommand.js';
import { fsUtil } from '../utils/fsUtil.js';
import { gitHubUtil } from '../utils/githubUtil.js';
import { globIgnore } from '../utils/globUtil.js';
import { combineMerge } from '../utils/mergeUtil.js';
import { doesContainJava, doesContainJsOrTs } from '../utils/packageCapabilities.js';
import { promisePool } from '../utils/promisePool.js';
import { spawnSync, spawnSyncAndReturnStdout } from '../utils/spawnUtil.js';
import { getTsconfigBaseDependencies, managedTsconfigBaseDependencies } from '../utils/tsconfigBase.js';
import { parseSourceFile } from '../utils/typescriptApi.js';
import { isPublishedWillboosterConfigsPackage } from '../utils/willboosterConfigsUtil.js';
import {
  getDeclaredWorkspacePatterns,
  getWorkspacePackageJsonPaths,
  hasDeclaredPackagesStarPattern,
  hasImplicitWorkspaceBaseline,
} from '../utils/workspaceUtil.js';
import { bunMinimumReleaseAgeExcludes, bunMinimumReleaseAgeSeconds } from './bunfig.js';

const oxlintDeps = ['@willbooster/oxfmt-config', '@willbooster/oxlint-config', 'oxfmt', 'oxlint', 'oxlint-tsgolint'];
const typescriptDependency = 'typescript';
// TypeScript 7's `typescript` package is the tsgo native compiler and exposes no
// programmatic API. Next.js's build-time `verifyTypeScriptSetup` needs that API, so
// `next build` fails ("trying to use TypeScript but do not have the required package(s)")
// with only `typescript` v7 installed. Next.js resolves the tsgo binary through the
// separate `@typescript/native-preview` package, so Next.js-family repos must install
// both; other repos only need `typescript` for `tsc` typechecks.
const typescriptGoDependency = '@typescript/native-preview';
const wbDependency = '@willbooster/wb';
const buildTsDependency = 'build-ts';
const lefthookDependency = 'lefthook';
const defaultGenI18nTsScript = 'gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP';
// The exact format-code commands old wbfy versions generated for JS/TS repos.
const legacyOxfmtFormatCodeScripts = new Set([
  'oxfmt --write --no-error-on-unmatched-pattern .',
  "oxfmt --write --no-error-on-unmatched-pattern . '!**/package.json'",
]);
const managedDependencyNames = new Set([
  wbDependency,
  buildTsDependency,
  lefthookDependency,
  typescriptDependency,
  typescriptGoDependency,
  'sort-package-json',
  // Mixed @types/bun versions across a monorepo load two bun-types copies, which
  // breaks global interface merging (e.g. Response/Headers) during type checking.
  '@types/bun',
  ...oxlintDeps,
]);
const willBoosterConfigsManagedDependencies = [
  '@willbooster/prettier-config',
  ...oxlintDeps.filter((dependency) => dependency.startsWith('@willbooster/')),
];
const obsoleteLintDependencies = [
  '@biomejs/biome',
  '@eslint-react/eslint-plugin',
  '@eslint/js',
  '@next/eslint-plugin-next',
  '@types/eslint',
  '@types/micromatch',
  '@typescript-eslint/eslint-plugin',
  '@typescript-eslint/parser',
  '@willbooster/biome-config',
  '@willbooster/eslint-config',
  '@willbooster/eslint-config-blitz-next',
  '@willbooster/eslint-config-js',
  '@willbooster/eslint-config-js-react',
  '@willbooster/eslint-config-next',
  '@willbooster/eslint-config-react',
  '@willbooster/eslint-config-ts',
  '@willbooster/eslint-config-ts-react',
  'biome',
  'eslint',
  'eslint-config-flat-gitignore',
  'eslint-config-next',
  'eslint-config-prettier',
  'eslint-import-resolver-node',
  'eslint-import-resolver-typescript',
  'eslint-plugin-import',
  'eslint-plugin-import-x',
  'eslint-plugin-perfectionist',
  'eslint-plugin-prettier',
  'eslint-plugin-react',
  'eslint-plugin-react-compiler',
  'eslint-plugin-react-hooks',
  'eslint-plugin-sort-class-members',
  'eslint-plugin-sort-destructure-keys',
  'eslint-plugin-storybook',
  'eslint-plugin-unicorn',
  'eslint-plugin-unused-imports',
  'globals',
  'micromatch',
  'typescript-eslint',
];
const micromatchPackageNames = new Set(['micromatch', '@types/micromatch']);
const micromatchImportPattern =
  /\bfrom\s+['"]micromatch['"]|\brequire\(\s*['"]micromatch['"]\s*\)|\bimport\(\s*['"]micromatch['"]\s*\)/u;

const latestDependencyVersionCache = new Map<string, string>();
const npmPackageTimesCache = new Map<string, Record<string, string>>();
const dependencySectionKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

type WritablePackageJson = SetRequired<
  PackageJson,
  'scripts' | 'dependencies' | 'devDependencies' | 'peerDependencies'
>;

interface DependencyUpdates {
  dependencies: string[];
  devDependencies: string[];
  pythonDevDependencies: string[];
}

export async function generatePackageJson(
  config: PackageConfig,
  rootConfig: PackageConfig,
  skipAddingDeps: boolean
): Promise<void> {
  return logger.functionIgnoringException('generatePackageJson', async () => {
    await core(config, rootConfig, skipAddingDeps);
  });
}

async function core(config: PackageConfig, rootConfig: PackageConfig, skipAddingDeps: boolean): Promise<void> {
  const filePath = path.resolve(config.dirPath, 'package.json');
  const jsonObj = await readPackageJson(filePath);

  await removeDeprecatedStuff(config, jsonObj);
  await updateScripts(config, rootConfig, jsonObj);
  await ensureTrustedDependencies(config, jsonObj);
  moveManagedToolDependenciesToDevDependencies(jsonObj);
  const dependencyUpdates = await applyPackageJsonConventions(config, rootConfig, jsonObj);
  await normalizePackageMetadata(config, rootConfig, jsonObj, dependencyUpdates);
  addDependencyVersionsToPackageJson(config, rootConfig, jsonObj, dependencyUpdates, skipAddingDeps);
  await updatePrivatePackages(jsonObj);
  removeEmptyDependencySections(jsonObj);

  delete jsonObj.packageManager;
  // Yarn reads package.json from disk before deciding whether `yarn add -D`
  // conflicts with an existing regular dependency, so this write must finish
  // before installing the managed dependency updates below. Keep this generated
  // file sorted even when we later run the target repository's formatter so a
  // mid-run interruption never leaves package.json in a partially managed order.
  // A refused write (e.g. a symlinked package.json) must also abort the dependency installation
  // below: `bun add` follows the symlink and would modify the file outside the repository.
  if (!(await fsUtil.generateFile(filePath, serializePackageJson(jsonObj)))) return;

  if (!skipAddingDeps) {
    installDependencyUpdates(config, jsonObj, dependencyUpdates);
    formatPackageJsonWithProjectFormatter(config, 'bun', filePath);
  }
}

function serializePackageJson(jsonObj: WritablePackageJson): string {
  // fsUtil.generateFile() normalizes the trailing newline, so keep the serializer
  // focused on the JSON payload itself.
  return JSON.stringify(sortPackageJson(jsonObj), undefined, 2);
}

async function readPackageJson(filePath: string): Promise<WritablePackageJson> {
  const jsonText = await fs.promises.readFile(filePath, 'utf8');
  const jsonObj = JSON.parse(jsonText) as PackageJson;
  jsonObj.scripts = jsonObj.scripts ?? {};
  jsonObj.dependencies = jsonObj.dependencies ?? {};
  jsonObj.devDependencies = jsonObj.devDependencies ?? {};
  jsonObj.peerDependencies = jsonObj.peerDependencies ?? {};
  return jsonObj as WritablePackageJson;
}

async function updateScripts(
  config: PackageConfig,
  rootConfig: PackageConfig,
  jsonObj: WritablePackageJson
): Promise<void> {
  removeLegacyInstallCommands(jsonObj.scripts);

  jsonObj.scripts = { ...jsonObj.scripts, ...generateScripts(config, jsonObj.scripts) };
  delete jsonObj.scripts['start-test-server'];

  delete jsonObj.scripts.prettify;
  // `bun wb lint --format` owns JS/TS formatting, so the oxfmt-based format-code script wbfy used
  // to generate is obsolete. Only the exact generated command is removed: custom format-code
  // scripts (and the Dart/Python variants regenerated later in normalizePackageMetadata) survive.
  if (legacyOxfmtFormatCodeScripts.has(jsonObj.scripts['format-code'] ?? '')) {
    delete jsonObj.scripts['format-code'];
  }
  convertYarnCommandsToBun(jsonObj.scripts, config, rootConfig);
  removeBunRuntimeFlagFromScripts(jsonObj.scripts);
}

function removeLegacyInstallCommands(scripts: PackageJson.Scripts): void {
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value !== 'string' || !value.includes('yarn')) continue;
    // Fresh repos still require standalone `yarn install`; only remove legacy install prefixes before another command.
    if (value.includes('git clone')) continue;
    scripts[key] = removeLegacyYarnInstallPrefixes(value);
  }
}

/**
 * Removes each `yarn && ` / `yarn install && ` prefix that precedes another command. The scan is
 * quote- and command-position-aware (sharing convertYarnInvocationsToBun's tokenizer walk), so
 * quoted data such as `echo 'yarn install && deploy now'` stays untouched.
 */
function removeLegacyYarnInstallPrefixes(script: string): string {
  const tokens = tokenizeShellCommand(script);
  const removalRanges: [number, number][] = [];
  forEachCommandPositionToken(tokens, (token, index) => {
    if (token.text !== 'yarn') return;
    const next = tokens[index + 1];
    // decodeSimpleShellWord: shell quoting makes `yarn 'install'` equivalent to `yarn install`.
    const separatorToken = next && decodeSimpleShellWord(next.text) === 'install' ? tokens[index + 2] : next;
    if (separatorToken?.text !== '&&') return;
    let end = separatorToken.end;
    while (end < script.length && /\s/u.test(script[end] ?? '')) end++;
    removalRanges.push([token.start, end]);
  });
  let result = script;
  for (const [start, end] of removalRanges.toReversed()) {
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

function updatePostinstallScript(
  scripts: PackageJson.Scripts,
  wranglerTypes: string | undefined,
  removesObsoleteWranglerTypes: boolean
): void {
  // On a worker-types opt-out (a wrangler package whose TypeScript project no longer consumes the
  // generated file), strip the generating default-output invocations wbfy used to manage from
  // postinstall — otherwise every install keeps recreating the now-unignored ~500KB file. Custom
  // pipelines (non-default output, wrappers, unmodeled shells) are classified differently and stay.
  if (removesObsoleteWranglerTypes && scripts.postinstall) {
    const remaining = splitCommandSegments(scripts.postinstall).filter((segment) => {
      if (segment === '') return false;
      const invocationArgs = parseWranglerTypesInvocation(segment);
      return !invocationArgs || classifyWranglerTypesInvocation(invocationArgs) !== 'reusableGenerator';
    });
    if (remaining.length > 0) {
      scripts.postinstall = remaining.join(' && ');
    } else {
      delete scripts.postinstall;
    }
  }
  if (scripts['gen-code']) {
    // Keep the project's own worker-types pipeline (prerequisites included — e.g. `node scripts/prepareTypes.js
    // && wrangler types ...`) when rewriting postinstall: dropping a prerequisite would leave fresh checkouts
    // unable to regenerate the file, and dropping the invocation itself (e.g. `wrangler types --config
    // config/worker.jsonc`, which wbfy does not manage, possibly behind a wrapper script) would drop the
    // generation entirely.
    const postinstallSegments = scripts.postinstall ? splitCommandSegments(scripts.postinstall) : [];
    const involvesWranglerTypes =
      reachesWranglerTypes(scripts.postinstall, scripts, () => true) ||
      // Shell forms the parser cannot model (e.g. `node scripts/prepare.js; wrangler types --config ...`,
      // a wrapper forwarding arguments) still generate on install and must survive the rewrite verbatim —
      // hence splitCommandSegments, which never truncates at a `cd`. A generator behind a real `cd` parses
      // in isolation but runs elsewhere, so it counts as involved too.
      postinstallSegments.some((segment) => isUnmodeledWranglerTypesSegment(segment, scripts)) ||
      (scriptChangesWorkingDirectory(scripts.postinstall ?? '') &&
        postinstallSegments.some((segment) => !!parseWranglerTypesInvocation(segment)));
    const preservedSegments = involvesWranglerTypes
      ? postinstallSegments.filter((segment) => segment !== '' && !isManagedGenCodeSegment(segment, scripts))
      : [];
    scripts.postinstall = ['wb gen-code', ...preservedSegments].join(' && ');
  } else if (scripts.postinstall?.includes('gen-i18n-ts')) {
    delete scripts.postinstall;
  }
  if (!wranglerTypes) return;
  // A Worker package without a gen-code script still needs worker-configuration.d.ts before type checking.
  // Wrapper invocations (e.g. `"postinstall": "yarn gen:types"`) already generate it, so adding the resolved
  // command would generate the ~15k-line file twice per install. Only a generating default-output invocation
  // counts: `wrangler types --check` or a custom output path leaves the managed file absent on a fresh clone.
  if (postinstallGeneratesWorkerTypes(scripts)) return;

  // A reachable non-generating invocation (e.g. `wrangler types --check`, which fails while the gitignored file
  // is still absent) must see the generated file, and a directory-changing postinstall (`cd ../tools && ...`)
  // would run an appended generator somewhere else — both need the generator first; otherwise append to keep
  // the project's own order.
  const oldPostinstall = scripts.postinstall;
  scripts.postinstall =
    oldPostinstall &&
    (reachesWranglerTypes(oldPostinstall, scripts, () => true) || scriptChangesWorkingDirectory(oldPostinstall))
      ? `${wranglerTypes} && ${oldPostinstall}`
      : appendWranglerTypes(oldPostinstall ?? '', wranglerTypes).replace(/^ && /u, '');
}

/**
 * Resolves the single `wrangler types` command that every managed script must run, or undefined when wbfy does not
 * manage worker-configuration.d.ts for the package.
 *
 * Scanning every script (not just postinstall) matters because projects keep the flagged invocation in a script of
 * their own, e.g. `"gen-types": "wrangler types --strict-vars=false"`. Reusing it keeps the declarations wbfy
 * regenerates identical to the ones the project intended: --strict-vars=false widens `vars` to string, whereas the
 * default emits literal union types. Both managed scripts get the same command so the file cannot depend on which of
 * them ran last. Only a generating default-output invocation qualifies (see
 * classifyWranglerTypesInvocation); anything else falls back to the managed default command.
 */
function resolveWranglerTypesCommand(config: PackageConfig, scripts: PackageJson.Scripts): string | undefined {
  if (!generatesWorkerTypes(config)) return;

  // Only an invocation passing flags is worth preserving; a bare one is normalized to the managed command.
  const { command } = selectProjectWranglerTypesGenerator(scripts);
  return command ?? 'bunx wrangler types';
}

/**
 * Cloudflare Workers projects rely on `wrangler types` to (re)generate the gitignored worker-configuration.d.ts.
 * Because `wb gen-code` does not produce it, append the command to code-generation scripts; otherwise a fresh
 * checkout (e.g. CI) would fail type checking.
 */
function appendWranglerTypes(script: string, wranglerTypes: string | undefined): string {
  if (!wranglerTypes) return script;
  return `${script} && ${wranglerTypes}`;
}

// Yarn CLI built-ins (v1 and Berry) that are not package scripts; converting them to
// `bun run <name>` would invoke a nonexistent script or the wrong action, so they are left
// untouched to surface during review.
const yarnBuiltinSubcommands = new Set([
  'add',
  'audit',
  'autoclean',
  'bin',
  'cache',
  'check',
  'config',
  'constraints',
  'create',
  'dedupe',
  'dlx',
  'exec',
  'explain',
  'generate-lock-entry',
  'global',
  'help',
  'import',
  'info',
  'init',
  'install',
  'licenses',
  'link',
  'list',
  'login',
  'logout',
  'node',
  'npm',
  'outdated',
  'owner',
  'pack',
  'patch',
  'patch-commit',
  'plugin',
  'policies',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'run',
  'search',
  'set',
  'stage',
  'tag',
  'team',
  'unlink',
  'unplug',
  'up',
  'upgrade',
  'upgrade-interactive',
  'version',
  'versions',
  'why',
  'workspace',
  'workspaces',
]);

interface ShellToken {
  text: string;
  start: number;
  end: number;
}

interface ShellReplacement {
  start: number;
  end: number;
  text: string;
}

function convertYarnCommandsToBun(
  scripts: PackageJson.Scripts,
  config: PackageConfig,
  rootConfig: PackageConfig
): void {
  // Yarn Berry treats ANY script name containing `:` as a potential "global" script: when the
  // invoking workspace does not define it, Yarn runs the single workspace (root included) that
  // does (plugin-essentials run.ts skips the lookup when several workspaces share the name). Bun
  // has no such concept, so the invocation must be routed to the defining workspace explicitly.
  // Resolved lazily: most scripts have no colon invocations.
  let colonScriptOwners: Map<string, ColonScriptOwner | undefined> | undefined;
  // Returns the `bun run ...` runner prefix to put before the (raw) script-name token, or
  // undefined to keep the yarn form.
  const resolveColonScriptInvocation = (scriptName: string, prefix: string): string | undefined => {
    if (typeof scripts[scriptName] === 'string') return 'bun run';
    colonScriptOwners ??= collectColonScriptOwners(rootConfig);
    const owner = colonScriptOwners.get(scriptName);
    const fallback = (): string | undefined =>
      // A missing or ambiguous leading-colon script cannot run locally either, so its yarn form
      // is kept (undefined) to surface in review; other unresolved colon names keep the plain
      // conversion (e.g. `cd sub && yarn build:sub` targeting a non-workspace directory).
      scriptName.startsWith(':') ? undefined : 'bun run';
    if (!owner) return fallback();
    // Bun's --filter never matches the workspace root, and its path filters resolve against the
    // invoking cwd (both verified on Bun 1.3.14), so the root package and unnamed workspaces are
    // addressed with --cwd relative to the invoking package instead.
    if (owner.packageName && owner.dirPath !== path.resolve(rootConfig.dirPath)) {
      return `bun run --filter ${owner.packageName}`;
    }
    // A `cd` BEFORE this invocation would make the package-relative --cwd resolve from the wrong
    // directory at runtime, so such invocations fall back instead of getting a silently broken
    // route; a cd after the invocation cannot affect it and must not prevent the conversion.
    if (prefixMayChangeWorkingDirectory(prefix)) return fallback();
    const relativeDirPath = path.relative(config.dirPath, owner.dirPath) || '.';
    return `bun run --cwd '${relativeDirPath.replaceAll("'", String.raw`'\''`)}'`;
  };
  // Managed repositories are Bun projects and wbfy deletes Yarn's configuration, so any leftover
  // yarn invocation in package scripts (e.g. postinstall) would fail on machines without Yarn.
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value !== 'string' || !/\byarn\b/u.test(value)) continue;
    scripts[key] = convertYarnInvocationsToBun(value, resolveColonScriptInvocation);
  }
}

/**
 * Rewrites the actual `yarn ...` command invocations in a script to their bun equivalents.
 *
 * The scan is quote- and command-position-aware (reusing removeBunRuntimeFlag's shell tokenizer
 * walk instead of bare regexes): `yarn` appearing as data — inside a quoted token (e.g.
 * `echo 'yarn build:cache'`) or as an argument of another command (e.g. `git commit -m yarn`) —
 * stays untouched, while a quoted argument token (e.g. `yarn ':build-cache'`) is decoded before
 * colon-owner resolution and re-emitted verbatim so its shell semantics never change. Anything
 * unconvertible keeps its yarn form verbatim to surface during review instead of being
 * mis-rewritten.
 *
 * Substitutions nested inside double quotes or backticks (`echo "$(yarn compile)"`) and quoted
 * script names containing whitespace (`yarn 'build docs'`) are deliberately NOT modeled: they
 * only produce conservative misses that keep the yarn form and surface during review (like the
 * regex-based predecessor), and covering them would require a full shell parser.
 */
function convertYarnInvocationsToBun(
  script: string,
  resolveColonScriptInvocation: (scriptName: string, prefix: string) => string | undefined
): string {
  const tokens = tokenizeShellCommand(script);
  const replacements: ShellReplacement[] = [];
  forEachCommandPositionToken(tokens, (token, index) => {
    // Only a bare unquoted `yarn` word at command position starts an invocation.
    if (token.text !== 'yarn') return;
    const remainingTokens = tokens.slice(index + 1);
    const terminatorIndex = remainingTokens.findIndex((argToken) => isShellSeparator(argToken.text));
    const args = terminatorIndex === -1 ? remainingTokens : remainingTokens.slice(0, terminatorIndex);
    if (args.length === 0) {
      // A bare `yarn` (at the end or before a command separator) is an install. A control
      // operator that does not simply chain commands (a backgrounding `&`, a subshell
      // parenthesis) keeps the yarn form to surface in review.
      const terminatorText = terminatorIndex === -1 ? undefined : remainingTokens[terminatorIndex]?.text;
      if (terminatorText === undefined || /^(?:&&|\|{1,2}|;|\n)/u.test(terminatorText)) {
        replacements.push({ start: token.start, end: token.end, text: 'bun install' });
      }
      return;
    }
    const replacement = convertSingleYarnInvocation(token, args, script, resolveColonScriptInvocation);
    if (replacement) replacements.push(replacement);
  });
  let result = script;
  for (const { start, end, text } of replacements.toReversed()) {
    result = result.slice(0, start) + text + result.slice(end);
  }
  return result;
}

// `yarn workspaces foreach` flags under which `bun run --filter '*'` (which runs every workspace
// respecting dependency order) is an accepted equivalent of the fan-out. Anything else keeps the
// yarn form to surface during review: selection flags (--since, --from, --include, ...) restrict
// the workspaces, --dry-run suppresses execution, and parallelism flags (--parallel,
// --interlaced, --jobs) start dependent scripts concurrently — under Bun's dependency-ordered
// concurrency a long-running dependency would block its dependents forever.
const selectionNeutralForeachFlags = new Set(['--all', '--topological', '--topological-dev', '--verbose']);

/**
 * Converts one `yarn <args...>` invocation (args already cut at the next command separator) into
 * the text replacing it, or undefined to keep the yarn form untouched.
 */
function convertSingleYarnInvocation(
  yarnToken: ShellToken,
  args: readonly ShellToken[],
  script: string,
  resolveColonScriptInvocation: (scriptName: string, prefix: string) => string | undefined
): ShellReplacement | undefined {
  // A redirection ends the arguments that decide the conversion (`yarn install > /dev/null`): the
  // rewrite never spans one, so the redirection survives verbatim after the replaced prefix.
  const redirectionIndex = args.findIndex((argToken) => isRedirectionOperator(argToken.text));
  const logicalArgs = redirectionIndex === -1 ? args : args.slice(0, redirectionIndex);
  // Decoded (literal) argument values drive the matching, while emitted rewrites always reuse the
  // raw token text (rawArg) so quoting and expansion semantics survive the conversion unchanged
  // (e.g. `yarn 'build:$target'` keeps its single quotes). A shell-ambiguous token decodes to
  // undefined, which keeps the invocation in its yarn form.
  const argText = (argIndex: number): string | undefined => {
    const arg = logicalArgs[argIndex];
    return arg && decodeSimpleShellWord(arg.text);
  };
  const rawArg = (argIndex: number): string => logicalArgs[argIndex]?.text ?? '';
  const replaceThroughArg = (argIndex: number, text: string): ShellReplacement | undefined => {
    const arg = logicalArgs[argIndex];
    return arg && { start: yarnToken.start, end: arg.end, text };
  };
  const first = argText(0);
  const second = argText(1);
  // `yarn workspaces foreach <selection-neutral flags> run <script>` fans a script out to every
  // workspace; a selection-restricting or execution-suppressing flag keeps the yarn form.
  if (first === 'workspaces' && second === 'foreach') {
    let runIndex = -1;
    // `--filter '*'` widens the fan-out to every workspace, so an explicit --all/-A selection is
    // required: an unflagged foreach is either scoped (Yarn <4.1) or an error (Yarn >=4.1).
    let selectsAllWorkspaces = false;
    for (let index = 2; index < logicalArgs.length; index++) {
      const flag = argText(index);
      if (flag === 'run') {
        runIndex = index;
        break;
      }
      if (flag === undefined || !(selectionNeutralForeachFlags.has(flag) || /^-[Atv]+$/u.test(flag))) return undefined;
      if (flag === '--all' || (flag.startsWith('-') && !flag.startsWith('--') && flag.includes('A'))) {
        selectsAllWorkspaces = true;
      }
    }
    const scriptName = runIndex === -1 || !selectsAllWorkspaces ? undefined : argText(runIndex + 1);
    return scriptName === undefined || scriptName.startsWith('-')
      ? undefined
      : replaceThroughArg(runIndex + 1, `bun run --filter '*' ${rawArg(runIndex + 1)}`);
  }
  if (first === 'dlx') return replaceThroughArg(0, 'bunx');
  if (first === 'workspace') {
    const hasRun = argText(2) === 'run';
    const commandIndex = hasRun ? 3 : 2;
    const command = argText(commandIndex);
    // Without an explicit `run`, a built-in like `yarn workspace pkg add -D x` is a Yarn CLI
    // action, not a script; Bun's --filter only executes package scripts.
    return second !== undefined &&
      command !== undefined &&
      /^[\w.:/-]+$/u.test(command) &&
      (hasRun || !yarnBuiltinSubcommands.has(command))
      ? replaceThroughArg(commandIndex, `bun run --filter ${rawArg(1)} ${rawArg(commandIndex)}`)
      : undefined;
  }
  // A colon-containing script name (after `run` and its flags, if any) needs workspace-global
  // resolution. The name may contain any non-metacharacter (e.g. `build:@scope`), not just
  // \w./:-. Only a leading `-` (a yarn flag) is excluded: Yarn's global lookup has no
  // first-character restriction, so names like `.build:cache` must resolve too.
  let scriptNameIndex = 0;
  if (first === 'run') {
    scriptNameIndex = 1;
    while (argText(scriptNameIndex)?.startsWith('-')) {
      // `--require <path>` is the one `yarn run` flag taking a separate value; its value must not
      // be mistaken for the script name (`--require=<path>` needs no special casing).
      scriptNameIndex += argText(scriptNameIndex) === '--require' ? 2 : 1;
    }
  }
  const scriptName = argText(scriptNameIndex);
  if (scriptName !== undefined && scriptName.includes(':') && /^[^\s;&|<>()'"`]+$/u.test(scriptName)) {
    const runnerPrefix = resolveColonScriptInvocation(scriptName, script.slice(0, yarnToken.start));
    if (runnerPrefix === undefined) return undefined;
    // With flags between `run` and the target (e.g. `yarn run --inspect-brk build:remote`), only
    // a plain local `bun run` provably keeps their meaning; where flags would have to travel into
    // a --filter/--cwd route, the yarn form is kept to surface in review.
    if (scriptNameIndex > 1) {
      return runnerPrefix === 'bun run' ? replaceThroughArg(0, 'bun run') : undefined;
    }
    return replaceThroughArg(scriptNameIndex, `${runnerPrefix} ${rawArg(scriptNameIndex)}`);
  }
  if (first === 'run') {
    // An unresolvable `yarn run [flags] :name` keeps its yarn form (the colon rule above already
    // converted every resolvable one), and so does an undecodable (dynamic or ambiguous) target:
    // its expanded name could need Yarn's global routing. Otherwise `bun run` accepts the same
    // flags and target.
    const target = logicalArgs[scriptNameIndex];
    return !target || scriptName === undefined || scriptName.startsWith(':') || target.text.startsWith(':')
      ? undefined
      : replaceThroughArg(0, 'bun run');
  }
  if (first === 'install') return replaceThroughArg(0, 'bun install');
  // A bare `yarn <name>` invokes the package script; Yarn built-ins, flag forms
  // (e.g. `yarn --cwd ...`), and still-unconverted `:` global scripts have no direct Bun
  // equivalent and are intentionally left untouched to surface during review.
  return first !== undefined && /^(?![-.:])[\w.:/-]+$/u.test(first) && !yarnBuiltinSubcommands.has(first)
    ? replaceThroughArg(0, `bun run ${rawArg(0)}`)
    : undefined;
}

/**
 * The literal value of a shell word that is either fully unquoted or wholly wrapped in one simple
 * quote pair, or undefined for anything shell-dynamic or ambiguous (unquoted expansions and
 * globs, embedded or mixed quotes, backslashes, expansions inside double quotes), whose
 * invocation must then stay in its yarn form.
 */
function decodeSimpleShellWord(text: string): string | undefined {
  // An unquoted `$var`, backtick, glob, or brace expansion resolves at runtime, so its literal
  // spelling must not drive script-name matching or colon-owner routing.
  if (!/['"\\]/u.test(text)) return /[$`*?[\]{}]|^~/u.test(text) ? undefined : text;
  const quoted = /^'([^'\\]*)'$/u.exec(text) ?? /^"([^"'\\$`]*)"$/u.exec(text);
  return quoted?.[1];
}

/**
 * Whether the script prefix may change the working directory before the command that follows it.
 * Any standalone `cd` (or `pushd`) token counts, wherever it appears — after separators, group
 * braces, or shell keywords like `then`/`do` — because a wrongly-suppressed --cwd route merely
 * surfaces in review, while a wrongly-emitted one breaks at runtime; false positives from `cd`
 * appearing as data are an acceptable cost of that asymmetry.
 */
function prefixMayChangeWorkingDirectory(prefix: string): boolean {
  return /(?<![\w./~-])(?:cd|pushd)(?![\w./~-])/u.test(prefix);
}

interface ColonScriptOwner {
  dirPath: string;
  packageName?: string;
}

/**
 * Maps each colon-containing (workspace-global) script name to the single workspace defining it,
 * or to undefined when several workspaces define it (Yarn refuses to run such an ambiguous
 * global script anyway).
 */
function collectColonScriptOwners(rootConfig: PackageConfig): Map<string, ColonScriptOwner | undefined> {
  const owners = new Map<string, ColonScriptOwner | undefined>();
  // The root manifest participates too: Yarn treats the root as a workspace, so a child may
  // invoke a root-owned global script. Unnamed manifests count as well — Yarn searches every
  // workspace's scripts regardless of its name.
  for (const packageJsonPath of new Set(['package.json', ...getWorkspacePackageJsonPaths(rootConfig)])) {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(path.resolve(rootConfig.dirPath, packageJsonPath), 'utf8')
      ) as PackageJson;
      const dirPath = path.dirname(path.resolve(rootConfig.dirPath, packageJsonPath));
      for (const scriptName of Object.keys(packageJson.scripts ?? {})) {
        if (!scriptName.includes(':')) continue;
        owners.set(scriptName, owners.has(scriptName) ? undefined : { dirPath, packageName: packageJson.name });
      }
    } catch {
      // An unreadable manifest only leaves its own global scripts unresolved.
    }
  }
  return owners;
}

function removeBunRuntimeFlagFromScripts(scripts: PackageJson.Scripts): void {
  // `bun --bun` prepends a node->bun PATH shim that leaks into every child process and breaks
  // tools requiring real Node.js (Playwright, wrangler, vinext), and wb 15 warns on every run when
  // it detects the shim. Only direct script-file executions (e.g. `exec bun --bun src/index.ts`),
  // where the shim is an intentional Bun-runtime opt-in for spawned children, are preserved.
  const scriptNames = new Set(Object.keys(scripts));
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value !== 'string' || !value.includes('--bun')) continue;
    scripts[key] = removeBunRuntimeFlag(value, scriptNames);
  }
}

function removeBunRuntimeFlag(script: string, scriptNames: ReadonlySet<string>): string {
  const tokens = tokenizeShellCommand(script);
  // A quote-aware scan (not a bare regex) so quoted literals (`echo "bun --bun ..."`), executables
  // merely ending in `bun` (`my-bun`), quoted targets with spaces, and Bun runtime flags between
  // `--bun` and the script file are all classified correctly.
  const removalRanges: [number, number][] = [];
  forEachCommandPositionToken(tokens, (token, index) => {
    if (unquoteShellToken(token.text) !== 'bun') return;
    const flagToken = tokens[index + 1];
    if (!flagToken || unquoteShellToken(flagToken.text) !== '--bun') return;
    if (shouldKeepBunRuntimeFlag(tokens.slice(index + 2), scriptNames)) return;
    removalRanges.push([flagToken.start, flagToken.end]);
  });

  let result = script;
  for (const [start, end] of removalRanges.toReversed()) {
    let whitespaceStart = start;
    while (whitespaceStart > 0 && /[ \t]/u.test(result[whitespaceStart - 1] ?? '')) whitespaceStart--;
    result = result.slice(0, whitespaceStart) + result.slice(end);
  }
  return result;
}

// Node-based tools the WillBooster stack invokes from package scripts; running them (or their
// children) under the bun-node shim breaks them, so `bun --bun <tool>` is unambiguously wrong.
const nodeBasedTools = new Set(['next', 'vite', 'vinext', 'wrangler', 'playwright']);

/**
 * Whether the tokens following `bun --bun` describe an invocation whose shim must survive. Only
 * unambiguous cases are stripped — a known Node-based tool, or a `bun run <package-script>` alias:
 * wrongly removing an intentional shim changes the runtime seen by child processes (Bun also
 * executes bare extensionless files directly), while wrongly keeping it only leaves wb's startup
 * warning.
 */
function shouldKeepBunRuntimeFlag(followingTokens: ShellToken[], scriptNames: ReadonlySet<string>): boolean {
  const positionals: string[] = [];
  for (const token of followingTokens) {
    if (isShellSeparator(token.text)) break;
    const tokenText = unquoteShellToken(token.text);
    // A flag may take a separate value (e.g. `--preload ./setup.ts`), so the real entrypoint is
    // unknowable without modeling the full option arity of Bun (and of `bun run`) — keep the flag.
    if (tokenText.startsWith('-')) return true;
    positionals.push(tokenText);
    // `bun run <file>` also executes script files directly, so its target decides too.
    if (positionals[0] !== 'run' || positionals.length === 2) break;
  }
  const [first, second] = positionals;
  if (first === undefined) return true;
  if (first === 'run') {
    // `bun run` also resolves package bins, so a known Node-based tool is unambiguous here too.
    if (second !== undefined && nodeBasedTools.has(second)) return false;
    // Otherwise `bun run <name>` is a package-script alias only when the name actually exists in
    // scripts; Bun may execute a file (even an extensionless one) of that name directly.
    return second === undefined || /[./$]/u.test(second) || !scriptNames.has(second);
  }
  return !nodeBasedTools.has(first);
}

/**
 * Invokes the callback for every token in shell command position: the first word of the script and
 * of every command after a separator. `KEY=VALUE` prefixes and redirections keep the next token in
 * command position.
 */
function forEachCommandPositionToken(
  tokens: readonly ShellToken[],
  callback: (token: ShellToken, index: number) => void
): void {
  let atCommandPosition = true;
  let redirectionOperandFollows = false;
  for (const [index, token] of tokens.entries()) {
    if (isShellSeparator(token.text)) {
      atCommandPosition = true;
      redirectionOperandFollows = false;
      continue;
    }
    if (redirectionOperandFollows) {
      redirectionOperandFollows = false;
      continue;
    }
    if (!atCommandPosition) continue;
    // A redirection may precede the command (`>out.log yarn build`); the operator and its operand
    // leave the position intact.
    if (isRedirectionOperator(token.text)) {
      redirectionOperandFollows = true;
      continue;
    }
    // The raw token text drives the assignment check: shell quoting turns it into an ordinary
    // command word (`"FOO=bar" yarn build` runs the command `FOO=bar`).
    if (/^[A-Za-z_]\w*=/u.test(token.text)) continue;
    atCommandPosition = false;
    callback(token, index);
  }
}

function tokenizeShellCommand(script: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let index = 0;
  while (index < script.length) {
    const char = script[index] ?? '';
    // An unquoted newline separates commands like `;`, so it must produce a separator token.
    if (/[^\S\n]/u.test(char)) {
      index++;
      continue;
    }
    if (isShellSeparator(char)) {
      let end = index + 1;
      while (end < script.length && script[end] === char) end++;
      tokens.push({ text: script.slice(index, end), start: index, end });
      index = end;
      continue;
    }
    // An unquoted redirection operator ends the preceding word even without whitespace
    // (`yarn build>log` redirects `yarn build`), so it forms its own token together with an
    // optional leading file descriptor (`2> /dev/null`).
    const redirectionOperator = /^\d*[<>]+/u.exec(script.slice(index))?.[0];
    if (redirectionOperator) {
      const end = index + redirectionOperator.length;
      tokens.push({ text: script.slice(index, end), start: index, end });
      index = end;
      continue;
    }
    let end = index;
    let quote: string | undefined;
    while (end < script.length) {
      const current = script[end] ?? '';
      if (quote) {
        if (current === quote) quote = undefined;
        else if (current === '\\' && quote === '"') end++;
      } else if (current === '"' || current === "'") {
        quote = current;
      } else if (current === '\\') {
        end++;
      } else if (/\s/u.test(current) || isShellSeparator(current) || current === '<' || current === '>') {
        break;
      }
      end++;
    }
    tokens.push({ text: script.slice(index, end), start: index, end });
    index = end;
  }
  return tokens;
}

function isShellSeparator(text: string): boolean {
  return /^[;|&()\n]+$/u.test(text);
}

function isRedirectionOperator(text: string): boolean {
  return /^\d*[<>]/u.test(text);
}

function unquoteShellToken(text: string): string {
  return text.replaceAll(/["']/gu, '');
}

async function applyPackageJsonConventions(
  config: PackageConfig,
  rootConfig: PackageConfig,
  jsonObj: WritablePackageJson
): Promise<DependencyUpdates> {
  const dependencies: string[] = [];
  const devDependencies = ['sort-package-json'];
  const pythonDevDependencies: string[] = [];
  const hasJava = doesContainJava(config);

  if (
    hasJava &&
    !fs.existsSync(path.join(rootConfig.dirPath, '.prettierrc.json')) &&
    !fs.existsSync(path.join(config.dirPath, '.prettierrc.json'))
  ) {
    jsonObj.prettier = '@willbooster/prettier-config';
    devDependencies.push('prettier-plugin-java', '@willbooster/prettier-config');
  }
  if (hasJava) {
    devDependencies.push('prettier');
  } else {
    removePrettierArtifacts(jsonObj);
  }

  delete jsonObj.devDependencies['lint-staged'];
  delete (jsonObj as PackageJson & { 'lint-staged'?: unknown })['lint-staged'];

  if (config.isRoot) {
    delete jsonObj.devDependencies.husky;
    delete jsonObj.scripts.postpublish;
    delete jsonObj.scripts.prepublishOnly;
    delete jsonObj.scripts.prepack;
    delete jsonObj.scripts.postpack;
    jsonObj.scripts.prepare = 'lefthook install || true';
    // When @willbooster/wb is a workspace of this repository, the generated `bun wb …` scripts run
    // its gitignored dist build (bin/index.js imports ../dist/index.js), so a fresh checkout must
    // build it during install; registry installs ship a prebuilt dist and need no extra step.
    const wbWorkspaceDir = getWorkspacePackageDirs(rootConfig).get(wbDependency);
    if (wbWorkspaceDir) {
      // Single quotes (with embedded quotes escaped) prevent the shell from expanding `$(…)` or
      // variables that a hostile directory name could smuggle into the generated script.
      jsonObj.scripts.prepare += ` && bun run --cwd '${wbWorkspaceDir.replaceAll("'", String.raw`'\''`)}' build`;
    }
    devDependencies.push(lefthookDependency);

    if (config.depending.semanticRelease) {
      if (doesReleaseScriptInstallSemanticRelease(jsonObj.scripts.release)) {
        delete jsonObj.devDependencies['semantic-release'];
      } else if (
        !jsonObj.devDependencies['semantic-release'] &&
        !jsonObj.devDependencies['multi-semantic-release'] &&
        !jsonObj.devDependencies['@qiwi/multi-semantic-release']
      ) {
        devDependencies.push('semantic-release');
      }
      jsonObj.version = '0.0.0-semantically-released';
    }

    if (config.depending.playwrightTest) {
      // Since artillery requires a specific version of @playwright/test
      const hasArtillery = jsonObj.dependencies.artillery || jsonObj.devDependencies.artillery;
      // Since llm-toolbox requires @playwright/test in dependencies
      if (!hasArtillery && !jsonObj.dependencies['@playwright/test']) {
        devDependencies.push('@playwright/test');
      }
      if (config.depending.playwrightRuntime) {
        // Runtime imports need the standalone package after Docker pruning removes devDependencies.
        jsonObj.dependencies.playwright ??=
          jsonObj.devDependencies.playwright ??
          jsonObj.dependencies['@playwright/test'] ??
          jsonObj.devDependencies['@playwright/test'];
        dependencies.push('playwright');
        delete jsonObj.devDependencies.playwright;
      } else {
        delete jsonObj.dependencies.playwright;
        delete jsonObj.devDependencies.playwright;
      }
    }

    if (config.doesContainSubPackageJsons) {
      // We don't allow non-array workspaces in monorepo. Yarn v1's object form keeps its
      // declared patterns (workspaces.packages); only extras such as nohoist are dropped.
      // Force `packages/*` only when it actually matches a workspace manifest: an apps/*-only
      // monorepo must not get a never-matching pattern appended to its declaration. A
      // baseline-seeding declaration needs no forced pattern at all — the seeded baseline
      // (`*/*` or `**`) already covers packages/*. The forced pattern is PREPENDED: Bun
      // evaluates workspace patterns sequentially, so a positive pattern placed after a user
      // negation would re-include the negated packages. A declaration that already covers
      // packages/* under normalization (e.g. `./packages/*`) is kept verbatim: forcing a textual
      // `packages/*` next to it would persist a duplicate equivalent pattern.
      const forcedPatterns =
        !hasImplicitWorkspaceBaseline(jsonObj.workspaces) &&
        !hasDeclaredPackagesStarPattern(jsonObj.workspaces) &&
        fg.globSync('packages/*/package.json', { cwd: config.dirPath, ignore: ['**/node_modules/**'] }).length > 0
          ? ['packages/*']
          : [];
      jsonObj.workspaces = merge.all([forcedPatterns, getDeclaredWorkspacePatterns(jsonObj.workspaces)], {
        arrayMerge: combineMerge,
      });
      // Both inputs can be empty (e.g. packages/package.json without any packages/*/package.json
      // and no declared workspaces); do not persist a meaningless `workspaces: []`.
      if (Array.isArray(jsonObj.workspaces) && jsonObj.workspaces.length === 0) {
        delete jsonObj.workspaces;
      }
    } else if (Array.isArray(jsonObj.workspaces)) {
      jsonObj.workspaces = jsonObj.workspaces.filter(
        (workspace) =>
          fg.globSync(workspace, {
            dot: true,
            cwd: config.dirPath,
            ignore: globIgnore,
          }).length > 0
      );
      if (jsonObj.workspaces.length === 0) {
        delete jsonObj.workspaces;
      }
    }
  }

  // fixers/nextConfig.ts enables `reactCompiler: true` for every Next.js project, and Next.js
  // resolves `babel-plugin-react-compiler` at build time when React Compiler is on. Add it here so
  // the managed next.config never breaks `next build` with an unresolved-package error.
  if (config.depending.next) {
    devDependencies.push('babel-plugin-react-compiler');
  }

  if (!isWbPackage(jsonObj)) {
    // A `workspace:` specifier depends on the wb developed in this repository (e.g.
    // WillBooster/shared itself); installing the latest registry release over it would silently
    // replace the local build with a published one, so leave such a declaration untouched.
    const wbSpecifier = jsonObj.dependencies[wbDependency] ?? jsonObj.devDependencies[wbDependency];
    if (!wbSpecifier?.startsWith('workspace:')) {
      if (shouldKeepWbAsRuntimeDependency(jsonObj)) {
        dependencies.push(wbDependency);
      } else {
        devDependencies.push(wbDependency);
      }
    }
  }
  // build-ts owns TypeScript execution and declaration emit. wbfy must always
  // keep existing build-ts users current because older releases can emit .d.ts
  // files at paths that no longer match package exports.
  if (
    jsonObj.dependencies[buildTsDependency] ||
    jsonObj.devDependencies[buildTsDependency] ||
    Object.values(jsonObj.scripts).some((script) => script?.includes(buildTsDependency))
  ) {
    if (shouldKeepBuildTsAsRuntimeDependency(jsonObj)) {
      dependencies.push(buildTsDependency);
    } else {
      devDependencies.push(buildTsDependency);
    }
  }
  if (doesContainJsOrTs(config)) {
    devDependencies.push(...oxlintDeps);
  }

  const tsconfigBaseDependencies = doesContainJsOrTs(config) ? getTsconfigBaseDependencies(config) : [];
  await removeUnusedTsconfigBaseDependencies(config, jsonObj, tsconfigBaseDependencies);
  devDependencies.push(...tsconfigBaseDependencies);

  if (config.doesContainTypeScript || config.doesContainTypeScriptInPackages) {
    // TypeScript 7 ships the native compiler as the `typescript` package, so it is
    // now the managed compiler for every TypeScript repo (typechecking runs `tsc`).
    devDependencies.push(typescriptDependency);
    // Next.js's `next build` inspects `@typescript/native-preview` (tsgo) to run its type
    // check; the `typescript` v7 package alone lacks the API next needs, so keep both
    // installed for Next.js-family repos. See the typescriptGoDependency comment above.
    if (config.depending.next || config.depending.blitz || config.depending.vinext) {
      devDependencies.push(typescriptGoDependency);
    }
    // React Native relies on @tsconfig/react-native's ambient types instead of @types/bun.
    if (!config.depending.reactNative) {
      devDependencies.push('@types/bun');
    }
    if (
      jsonObj.dependencies.jest ||
      jsonObj.devDependencies.jest ||
      jsonObj.dependencies['@jest/globals'] ||
      jsonObj.devDependencies['@jest/globals'] ||
      jsonObj.dependencies['ts-jest'] ||
      jsonObj.devDependencies['ts-jest']
    ) {
      devDependencies.push('@types/jest');
    }
  }

  if (config.isWillBoosterConfigs) {
    return {
      dependencies: dependencies.filter((dep) => !dep.includes('@willbooster/')),
      devDependencies: devDependencies.filter((dep) => !dep.includes('@willbooster/')),
      pythonDevDependencies,
    };
  }

  return { dependencies, devDependencies, pythonDevDependencies };
}

function doesReleaseScriptInstallSemanticRelease(script: unknown): boolean {
  if (typeof script !== 'string') return false;
  return /\b(?:bunx|npx|pnpm\s+dlx|yarn\s+dlx)\s+semantic-release(?:@\S+)?\b/u.test(script);
}

function moveManagedToolDependenciesToDevDependencies(jsonObj: WritablePackageJson): void {
  for (const [dependency, keepAsRuntime] of [
    [wbDependency, shouldKeepWbAsRuntimeDependency(jsonObj)],
    [buildTsDependency, shouldKeepBuildTsAsRuntimeDependency(jsonObj)],
  ] as const) {
    if (keepAsRuntime) {
      const devVersion = jsonObj.devDependencies[dependency];
      if (!devVersion) continue;
      const runtimeVersion = jsonObj.dependencies[dependency];
      if (!runtimeVersion || isNewerPackageVersion(devVersion, runtimeVersion)) {
        jsonObj.dependencies[dependency] = devVersion;
      }
      delete jsonObj.devDependencies[dependency];
    } else if (jsonObj.dependencies[dependency]) {
      jsonObj.devDependencies[dependency] ??= jsonObj.dependencies[dependency];
      delete jsonObj.dependencies[dependency];
    }
  }
}

function shouldKeepWbAsRuntimeDependency(jsonObj: PackageJson): boolean {
  const postinstallScript = jsonObj.scripts?.postinstall;
  return typeof postinstallScript === 'string' && /\bwb\b/u.test(postinstallScript);
}

function shouldKeepBuildTsAsRuntimeDependency(jsonObj: PackageJson): boolean {
  const prisma = jsonObj.prisma as { seed?: unknown } | undefined;
  return doesSeedCommandUseBuildTs(prisma?.seed) || doesSeedCommandUseBuildTs(jsonObj.scripts?.seed);
}

function doesSeedCommandUseBuildTs(seedCommand: unknown): boolean {
  // Production Docker images run seed scripts after devDependencies are pruned,
  // so TypeScript seed runners must remain available at runtime.
  return typeof seedCommand === 'string' && /(?<![\w-])build-ts(?![\w-])/u.test(seedCommand);
}

const dependencyDeclarationSections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/**
 * Forces store-incompatible packages to stay project-local under Bun's global store
 * (`globalStore = true` in the generated bunfig.toml): `chakra typegen` (run by `wb gen-code`)
 * writes generated types into the installed @chakra-ui/react package, which would otherwise
 * mutate the machine-wide store shared across repositories, and drizzle-kit requires drizzle-orm
 * without declaring it, which the store realpath places beyond a plain node_modules walk-up.
 * Listing them in `trustedDependencies` makes Bun materialize a per-project copy under
 * `node_modules/.bun/`, whose sibling `node_modules/.bun/node_modules/` links every installed
 * package and therefore resolves the undeclared requires.
 */
async function ensureTrustedDependencies(config: PackageConfig, jsonObj: WritablePackageJson): Promise<void> {
  // Bun consults trustedDependencies in the workspace root's package.json only, so the list is
  // managed there and must cover dependencies declared anywhere in the repository.
  if (!config.isRoot) return;
  const bunJsonObj = jsonObj as WritablePackageJson & { trustedDependencies?: string[] };
  // Bun installs optional and peer dependencies by default, so all declaration sections count.
  // Every declared range is kept per package: a root declaration must not mask a workspace one
  // (e.g. root @chakra-ui/cli v2 alongside a workspace on v3).
  const declaredDependencies = new Map<string, string[]>();
  const addDeclaredDependencies = (packageJson: PackageJson): void => {
    for (const section of dependencyDeclarationSections) {
      for (const [dependencyName, versionRange] of Object.entries(packageJson[section] ?? {})) {
        if (typeof versionRange === 'string') {
          const versionRanges = declaredDependencies.get(dependencyName);
          if (versionRanges) {
            versionRanges.push(versionRange);
          } else {
            declaredDependencies.set(dependencyName, [versionRange]);
          }
        }
      }
    }
  };
  addDeclaredDependencies(jsonObj);
  for (const packageJsonPath of getWorkspacePackageJsonPaths(config)) {
    try {
      addDeclaredDependencies(
        JSON.parse(await fs.promises.readFile(path.resolve(config.dirPath, packageJsonPath), 'utf8')) as PackageJson
      );
    } catch {
      // ignore unreadable workspace package.json
    }
  }
  // Only @chakra-ui/cli v3's `chakra typegen` writes into the installed @chakra-ui/react;
  // v2's `chakra-cli tokens` writes into @chakra-ui/styled-system instead, so trusting
  // @chakra-ui/react there would force a useless project-local copy without fixing gen-code.
  // Mirror wb gen-code's classification: only a range whose leading major parses to 2 selects the
  // v2 command, so digitless specs like `latest` or catalog references count as v3.
  const hasChakraCliV3 = (declaredDependencies.get('@chakra-ui/cli') ?? []).some(
    (versionRange) => /\d+/u.exec(versionRange)?.[0] !== '2'
  );
  const requiredWbfyPackages = [
    ...(hasChakraCliV3 && declaredDependencies.has('@chakra-ui/react') ? ['@chakra-ui/react'] : []),
    ...(declaredDependencies.has('drizzle-kit') ? ['drizzle-kit'] : []),
    // These git-dependency builds import packages they do not declare (e.g. zod), which the
    // global-store layout places beyond their walk-up; a project-local copy under
    // node_modules/.bun resolves them (observed in WillBooster/prompt-study).
    ...(declaredDependencies.has('@willbooster/judge') ? ['@willbooster/judge'] : []),
    ...(declaredDependencies.has('@willbooster/llm-proxy') ? ['@willbooster/llm-proxy'] : []),
  ];

  // wbfy fully owns this field: a package whose lifecycle scripts must run gets added to wbfy
  // itself instead of to individual repositories, so unmanaged entries are always removed —
  // including an explicitly empty deny-all list, whose deletion deliberately restores Bun's
  // default allow-list (the ownership policy chosen in #975).
  const existingTrusted = bunJsonObj.trustedDependencies;
  if (requiredWbfyPackages.length === 0) {
    if (existingTrusted !== undefined) {
      // Deleting the field restores Bun's full default allow-list, so only entries outside that
      // list actually lose their lifecycle scripts.
      warnAboutRemovedTrustedDependencies(config, existingTrusted, new Set());
      delete bunJsonObj.trustedDependencies;
    }
    return;
  }

  // An explicit trustedDependencies list REPLACES Bun's default allow-list instead of extending
  // it, and Bun prints no warning for the postinstalls it consequently skips (e.g. @railway/cli
  // downloads its binary in postinstall and exits 1 without one). Include the ENTIRE default list:
  // entries for packages that are not installed are inert, and this is the only representation
  // that stays correct for transitive dependencies the final `bun install` resolves after this
  // runs — an intersection with a missing or stale lockfile would silently drop them.
  const defaultTrustedDependencies = getDefaultTrustedDependencies(config);
  // lefthook is appended explicitly so the default-list lookup failing cannot drop it: it is
  // required in every managed repository.
  const newTrustedPackages = new Set([
    ...requiredWbfyPackages,
    lefthookDependency,
    ...(defaultTrustedDependencies ?? []),
  ]);
  warnAboutRemovedTrustedDependencies(config, existingTrusted ?? [], newTrustedPackages);
  bunJsonObj.trustedDependencies = [...newTrustedPackages].toSorted();
}

// The packages wbfy itself may write into trustedDependencies; their removal is managed cleanup,
// never a loss of user policy.
const wbfyManagedTrustedDependencies = new Set([
  '@chakra-ui/react',
  '@willbooster/judge',
  '@willbooster/llm-proxy',
  'drizzle-kit',
  lefthookDependency,
]);

function warnAboutRemovedTrustedDependencies(
  config: PackageConfig,
  existingTrusted: readonly string[],
  keptPackages: ReadonlySet<string>
): void {
  // A default-trusted entry never loses anything by removal: while the package is installed the
  // kept list (or, when the field is deleted, Bun's own default list) still trusts it.
  const defaultTrustedDependencies = getDefaultTrustedDependencies(config);
  const removedPackages = existingTrusted.filter(
    (pkg) => !keptPackages.has(pkg) && !wbfyManagedTrustedDependencies.has(pkg) && !defaultTrustedDependencies?.has(pkg)
  );
  if (removedPackages.length > 0) {
    console.warn(
      `Removing unmanaged trustedDependencies entries: ${removedPackages.join(', ')}. wbfy owns this field; if their lifecycle scripts are required, add the packages to wbfy itself.`
    );
  }
}

let cachedDefaultTrustedDependencies: Set<string> | undefined;

/** Fetches Bun's default trusted-dependency allow-list from the Bun version installing the repository. */
function getDefaultTrustedDependencies(config: PackageConfig): Set<string> | undefined {
  if (!cachedDefaultTrustedDependencies) {
    // Bun colorizes the list markers when FORCE_COLOR is set (e.g. by test runners on CI), so
    // ANSI escape sequences must be stripped before parsing.
    const stdout = spawnSyncAndReturnStdout('bun', ['pm', 'default-trusted'], config.dirPath).replaceAll(
      // oxlint-disable-next-line no-control-regex -- matching ANSI escape sequences requires the ESC control character
      /\u001B\[[0-9;]*m/gu,
      ''
    );
    const parsedDependencies = new Set([...stdout.matchAll(/^\s*-\s+(\S+)$/gmu)].map((match) => match[1] as string));
    if (parsedDependencies.size === 0) {
      // Do not cache the failure: a target-local problem (e.g. an unreadable package.json) must
      // not deny the default list to every later target of a multi-path run.
      console.warn('Failed to read the default allow-list via `bun pm default-trusted`.');
      return undefined;
    }
    cachedDefaultTrustedDependencies = parsedDependencies;
  }
  return cachedDefaultTrustedDependencies;
}

async function normalizePackageMetadata(
  config: PackageConfig,
  rootConfig: PackageConfig,
  jsonObj: WritablePackageJson,
  dependencyUpdates: DependencyUpdates
): Promise<void> {
  if (!jsonObj.name) {
    jsonObj.name = path.basename(config.dirPath);
  }

  // A monorepo root configured for npm publishing (semantic-release with `@semantic-release/npm`
  // — via an explicit plugin entry, the plugin-less default list, or a config packageConfig
  // cannot inspect statically such as JS/YAML or an `extends` preset — or an explicit
  // `publishConfig`) must not be forced private: `@semantic-release/npm` silently skips private
  // packages, so forcing `private: true` would stop releases without any error (e.g.
  // WillBoosterLab/llm-proxy publishing @willbooster-private/llm-proxy).
  if (config.doesContainSubPackageJsons && (config.release.npmPublishesRoot || jsonObj.publishConfig)) {
    // Older wbfy forced `private: true` on every monorepo root (and never added a publishConfig
    // to one, since it only does that for non-private manifests — so a root-level publishConfig
    // is user-authored publishing intent); when the user has EXPLICITLY configured
    // `@semantic-release/npm` to publish the root itself, or declared a `publishConfig`, that
    // stale flag silently suppresses publishing, so migrate it away. Roots relying on the
    // plugin-less default list keep their `private` value untouched: `private: true` there can
    // be a deliberate opt-out, which `@semantic-release/npm` honors by defaulting npmPublish to
    // false.
    delete jsonObj.private;
  } else if (config.doesContainSubPackageJsons && !config.release.npm && !jsonObj.publishConfig) {
    jsonObj.private = true;
  }
  if (!jsonObj.license) {
    jsonObj.license = 'UNLICENSED';
  }
  if (!jsonObj.private && jsonObj.license !== 'UNLICENSED' && rootConfig.isPublicRepo) {
    jsonObj.publishConfig ??= {};
    jsonObj.publishConfig.access ??= 'public';
  }
  const [owner] = gitHubUtil.getOrgAndName(config.repository ?? '');
  if (owner === 'WillBooster' || owner === 'WillBoosterLab') {
    jsonObj.author = 'WillBooster Inc.';
  }
  await normalizePublishedConfigPackageMetadata(config, jsonObj);
  if (!config.isRoot && jsonObj.private && !jsonObj.main) {
    // Make VSCode possible to refactor code across subpackages.
    jsonObj.main = './src';
  }

  // Yarn treats the legacy npm/chalk resolution alias as an invalid package token.
  delete jsonObj.resolutions?.['npm/chalk'];

  if (!config.doesContainSubPackageJsons) {
    if (config.doesContainPubspecYaml) {
      jsonObj.scripts.lint = 'flutter analyze';
      jsonObj.scripts['lint-fix'] = 'bun run lint';
      const dirs = ['lib', 'test', 'test_driver'].filter((dir) => fs.existsSync(path.resolve(config.dirPath, dir)));
      if (dirs.length > 0) {
        jsonObj.scripts['format-code'] = `dart format $(find ${dirs.join(
          ' '
        )} -name generated -prune -o -name '*.freezed.dart' -prune -o -name '*.g.dart' -prune -o -name '*.dart' -print)`;
        jsonObj.scripts.format = appendFormatCodeCommand(jsonObj.scripts.format);
      }
    }

    const pythonPackageManager = getPythonPackageManager(config);
    if (pythonPackageManager) {
      if (jsonObj.scripts.postinstall === 'poetry install') {
        delete jsonObj.scripts.postinstall;
      }
      const scriptRunner = 'bun run';
      jsonObj.scripts['common/ci-setup'] = `${scriptRunner} setup-${pythonPackageManager}`;
      delete jsonObj.scripts[`setup-${pythonPackageManager === 'poetry' ? 'uv' : 'poetry'}`];
      delete jsonObj.scripts['setup-poetry-asdf'];
      jsonObj.scripts[`setup-${pythonPackageManager}`] = getPythonSetupCommand(pythonPackageManager);
      const pythonFiles = await fg.glob('**/*.py', {
        cwd: config.dirPath,
        dot: true,
        ignore: globIgnore,
      });
      const dirNameSet = new Set<string>();
      for (const pythonFile of pythonFiles) {
        const [first, second] = pythonFile.split('/');
        if (first && second) {
          dirNameSet.add(first);
        }
      }
      if (dirNameSet.size > 0) {
        const dirNamesStr = [...dirNameSet].join(' ');
        const pythonRunner = `${pythonPackageManager} run`;
        jsonObj.scripts['format-code'] =
          `${pythonRunner} isort --profile black ${dirNamesStr} && ${pythonRunner} black ${dirNamesStr}`;
        if (jsonObj.scripts.lint) {
          jsonObj.scripts.lint = `${pythonRunner} flake8 ${dirNamesStr} && ${jsonObj.scripts.lint}`;
        } else {
          jsonObj.scripts.lint = `${pythonRunner} flake8 ${dirNamesStr}`;
          jsonObj.scripts['lint-fix'] = `${scriptRunner} lint`;
        }
        jsonObj.scripts.format = appendFormatCodeCommand(jsonObj.scripts.format);
        dependencyUpdates.pythonDevDependencies.push('black', 'isort', 'flake8');
      }
    }
  }

  if (config.repository || jsonObj.repository) {
    jsonObj.repository = formatRepositoryForPackageJson(config.repository ?? jsonObj.repository, jsonObj.repository);
  }

  // Resolved before the managed scripts are overwritten, so a project-specific invocation is still visible.
  const wranglerTypes = resolveWranglerTypesCommand(config, jsonObj.scripts);
  const genCodeScript = jsonObj.scripts['gen-code'];
  if (genCodeScript?.includes('No code generation needed')) {
    delete jsonObj.scripts['gen-code'];
  } else if (shouldGenerateWbGenCodeScript(config, genCodeScript)) {
    jsonObj.scripts['gen-code'] = appendWranglerTypes('bun wb gen-code', wranglerTypes);
  } else if (
    genCodeScript &&
    wranglerTypes &&
    !reachesWranglerTypes(
      genCodeScript,
      jsonObj.scripts,
      (invocationArgs) => classifyWranglerTypesInvocation(invocationArgs) === 'reusableGenerator'
    )
  ) {
    // A project-specific gen-code must produce the same declarations as postinstall, or running the documented
    // code-generation entry point would leave the generated worker types stale. Like the postinstall rewrite,
    // a reachable non-generating invocation (e.g. `wrangler types --check`) or a directory change needs the
    // generator first.
    jsonObj.scripts['gen-code'] =
      reachesWranglerTypes(genCodeScript, jsonObj.scripts, () => true) || scriptChangesWorkingDirectory(genCodeScript)
        ? `${wranglerTypes} && ${genCodeScript}`
        : appendWranglerTypes(genCodeScript, wranglerTypes);
  }
  normalizeGenI18nTsScript(config, jsonObj);
  updatePostinstallScript(
    jsonObj.scripts,
    wranglerTypes,
    config.doesContainWranglerConfig && !wranglerTypes && !consumesGeneratedWorkerTypes(config)
  );

  if (!jsonObj.dependencies.prettier) {
    // Because @types/prettier blocks prettier execution.
    delete jsonObj.devDependencies['@types/prettier'];
  }
}

function shouldGenerateWbGenCodeScript(config: PackageConfig, oldGenCodeScript: string | undefined): boolean {
  return (
    config.depending.blitz ||
    config.depending.chakra ||
    config.depending.genI18nTs ||
    config.depending.prisma ||
    (config.depending.drizzle && !!oldGenCodeScript?.includes('drizzle-kit check'))
  );
}

function appendFormatCodeCommand(formatScript: string | undefined): string {
  return formatScript ? `${formatScript} && bun run format-code` : 'bun run format-code';
}

function normalizeGenI18nTsScript(config: PackageConfig, jsonObj: WritablePackageJson): void {
  if (!shouldManageGenI18nTs(config)) return;

  if (jsonObj.scripts['gen-i18n-ts'] === defaultGenI18nTsScript) {
    delete jsonObj.scripts['gen-i18n-ts'];
  }
}

async function normalizePublishedConfigPackageMetadata(
  config: PackageConfig,
  jsonObj: WritablePackageJson
): Promise<void> {
  if (!isPublishedWillboosterConfigsPackage(config)) return;

  const configMjsPath = path.resolve(config.dirPath, 'config.mjs');
  if (!fs.existsSync(configMjsPath)) return;

  jsonObj.type = 'module';

  const configDtsPath = path.resolve(config.dirPath, 'config.d.ts');
  if (!fs.existsSync(configDtsPath)) return;

  jsonObj.files = [...new Set([...(jsonObj.files ?? []), 'config.d.mts'])];
  // NodeNext resolves a relative `./config.mjs` import to `config.d.mts`, not
  // the package-level `types` field. Keep the published config importable from
  // package-local TypeScript linter settings.
  await promisePool.run(() => fsUtil.generateFile(path.resolve(config.dirPath, 'config.d.mts'), configDmtsContent));
}

const configDmtsContent = `export { default } from './config.js';
`;

function addDependencyVersionsToPackageJson(
  config: PackageConfig,
  rootConfig: PackageConfig,
  jsonObj: WritablePackageJson,
  dependencyUpdates: DependencyUpdates,
  skipAddingDeps: boolean
): void {
  const packageJsonDependencies = jsonObj.dependencies;
  const packageJsonDevDependencies = jsonObj.devDependencies;
  dependencyUpdates.dependencies = addPackageJsonDependencies(
    config,
    rootConfig,
    jsonObj,
    packageJsonDependencies,
    [...dependencyUpdates.dependencies, ...getExistingManagedDependencies(packageJsonDependencies, jsonObj)],
    skipAddingDeps
  );
  dependencyUpdates.devDependencies = dependencyUpdates.devDependencies.filter((dep) => !packageJsonDependencies[dep]);
  dependencyUpdates.devDependencies = addPackageJsonDependencies(
    config,
    rootConfig,
    jsonObj,
    packageJsonDevDependencies,
    [...dependencyUpdates.devDependencies, ...getExistingManagedDependencies(packageJsonDevDependencies, jsonObj)],
    skipAddingDeps
  );
}

function getExistingManagedDependencies(
  packageJsonDependencies: Partial<Record<string, string>>,
  jsonObj: PackageJson
): string[] {
  return Object.keys(packageJsonDependencies).filter(
    (dependency) =>
      managedDependencyNames.has(dependency) &&
      // A public package's `workspace:` specifier must never be re-managed via a registry install
      // (private ones are normalized to `workspace:*` later). This also covers running wbfy on a
      // monorepo SUBDIRECTORY, where the parent's workspaces are invisible and the workspace-map
      // guard in addPackageJsonDependencies cannot protect the specifier.
      (jsonObj.private || !packageJsonDependencies[dependency]?.startsWith('workspace:'))
  );
}

function removeEmptyDependencySections(jsonObj: PackageJson): void {
  for (const key of dependencySectionKeys) {
    const section = jsonObj[key];
    if (section && Object.keys(section).length === 0) {
      Reflect.deleteProperty(jsonObj, key);
    }
  }
}

function installDependencyUpdates(
  config: PackageConfig,
  jsonObj: PackageJson,
  dependencyUpdates: DependencyUpdates
): void {
  const dependencies = dependencyUpdates.dependencies.filter((dep) => !jsonObj.devDependencies?.[dep]);
  installNpmDependencies(config, dependencies, false);

  const devDependencies = dependencyUpdates.devDependencies.filter((dep) => !jsonObj.dependencies?.[dep]);
  installNpmDependencies(config, devDependencies, true);

  const pythonPackageManager = getPythonPackageManager(config);
  if (pythonPackageManager && dependencyUpdates.pythonDevDependencies.length > 0) {
    const dependencies = [...new Set(dependencyUpdates.pythonDevDependencies)];
    if (pythonPackageManager === 'poetry') {
      spawnSync('poetry', ['add', '--group', 'dev', ...dependencies], config.dirPath);
    } else {
      spawnSync('uv', ['add', '--dev', ...dependencies], config.dirPath);
    }
  }
}

function getPythonPackageManager(config: PackageConfig): 'poetry' | 'uv' | undefined {
  if (config.doesContainUvLock) return 'uv';
  if (config.doesContainPoetryLock) return 'poetry';
}

function getPythonSetupCommand(packageManager: 'poetry' | 'uv'): string {
  if (packageManager === 'uv') return 'uv sync --frozen';
  // `mise which python` yields the single active interpreter path; `mise current python` can
  // print multiple space-separated versions (mise supports multi-version pins), which would pass
  // extra positional arguments to `poetry env use`. When mise is missing or python is
  // unconfigured, skip `poetry env use` and fall back to poetry's default interpreter instead of
  // aborting the chain.
  // The `|| true` covers only the mise resolution: a missing/unconfigured mise falls back to
  // poetry's default interpreter, while a failing `poetry env use` still aborts the chain.
  return 'poetry config virtualenvs.in-project true && { python_path="$(mise which python 2>/dev/null)" || true; } && { [ -z "$python_path" ] || poetry env use "$python_path"; } && poetry run pip install --upgrade pip && poetry install';
}

function installNpmDependencies(config: PackageConfig, dependencies: string[], dev: boolean): void {
  if (dependencies.length === 0) return;

  const dependencySpecifiers = [
    ...new Set(dependencies.map((dependency) => getInstallDependencySpecifier(config, dependency))),
  ];
  spawnSync('bun', ['add', ...(dev ? ['-D'] : []), '--exact', ...dependencySpecifiers], config.dirPath);
}

function addPackageJsonDependencies(
  config: PackageConfig,
  rootConfig: PackageConfig,
  jsonObj: WritablePackageJson,
  packageJsonDependencies: Partial<Record<string, string>>,
  dependencies: string[],
  skipAddingDeps: boolean
): string[] {
  const dependenciesToInstall: string[] = [];
  for (const dependency of new Set(dependencies)) {
    // A private package whose monorepo contains this dependency as a workspace must reference it
    // via the workspace protocol: pinning a registry version makes Bun shadow the same-name
    // workspace and skip installing the workspace's own dependencies. (Published packages instead
    // pin a concrete version because `npm publish` rejects `workspace:*` specifiers — but an
    // EXISTING `workspace:` declaration is always kept: overwriting it with a registry release
    // would silently break the local workspace link.)

    // A declared `workspace:` specifier always wins, whether or not the workspace map sees the
    // package: running wbfy on a monorepo SUBDIRECTORY hides the parent's workspaces, so the map
    // alone cannot be trusted to detect a local workspace link.
    if (packageJsonDependencies[dependency]?.startsWith('workspace:')) {
      if (jsonObj.private) {
        packageJsonDependencies[dependency] = 'workspace:*';
      }
      continue;
    }
    if (jsonObj.private && getWorkspacePackageDirs(rootConfig).has(dependency)) {
      const existingSpecifier = packageJsonDependencies[dependency];
      if (!existingSpecifier || existingSpecifier.startsWith('workspace:')) {
        packageJsonDependencies[dependency] = 'workspace:*';
        continue;
      }
      // An existing CONCRETE pin on a workspace package is a deliberate choice and must not be
      // converted to the workspace protocol. Note the trade-off either way: npm (which
      // semantic-release's npm plugin shells out to) cannot parse `workspace:` specifiers, while
      // a registry pin makes a cold bun install shadow the workspace and skip its dependencies —
      // WillBooster/shared keeps `workspace:*` and strips the protocol on the CI checkout right
      // before releasing (scripts/stripWorkspaceProtocol.mjs). Fall through so a concrete pin
      // keeps being bumped like any managed dependency.
    }
    const shouldUpdateExistingDependency = shouldUpdateExistingManagedDependency(
      config,
      dependency,
      packageJsonDependencies[dependency]
    );
    if (shouldUpdateExistingDependency) {
      dependenciesToInstall.push(dependency);
      if (!skipAddingDeps) continue;
    }
    if (
      packageJsonDependencies[dependency] &&
      !shouldUpdateExistingDependency &&
      packageJsonDependencies[dependency] !== '*'
    )
      continue;
    const latestVersion = getLatestDependencyVersion(config, dependency);
    if (latestVersion === '*' && packageJsonDependencies[dependency]) continue;
    packageJsonDependencies[dependency] = latestVersion;
  }
  return dependenciesToInstall;
}

function formatPackageJsonWithProjectFormatter(
  config: PackageConfig,
  packageManager: 'bun' | 'yarn',
  filePath: string
): void {
  const relativeFilePath = path.relative(config.dirPath, filePath);
  if (!relativeFilePath) return;

  // Reuse the target repository's own formatter after dependency installation so
  // package.json matches whatever its current sort-package-json version expects.
  // This avoids follow-up autofix commits caused only by formatter version drift
  // between wbfy and the project being updated.
  if (packageManager === 'bun') {
    spawnSync('bunx', ['sort-package-json', relativeFilePath], config.dirPath);
  } else {
    spawnSync(packageManager, ['sort-package-json', relativeFilePath], config.dirPath);
  }
}

// TODO: remove the following migration code in future
async function removeDeprecatedStuff(
  config: PackageConfig,
  jsonObj: SetRequired<PackageJson, 'scripts' | 'dependencies' | 'devDependencies' | 'peerDependencies'>
): Promise<void> {
  if (jsonObj.author === 'WillBooster LLC') {
    jsonObj.author = 'WillBooster Inc.';
  }
  removeSelfDependency(config, jsonObj);
  replaceWillBoosterConfigsWorkspaceDependencyRanges(config, jsonObj);
  delete jsonObj.scripts['sort-package-json'];
  delete jsonObj.scripts['sort-all-package-json'];
  delete jsonObj.scripts['check-all-for-ai'];
  delete jsonObj.scripts['check-for-ai'];
  delete jsonObj.scripts['typecheck/warn'];
  delete jsonObj.scripts['typecheck:gen-code'];
  delete jsonObj.scripts['typecheck:codegen'];
  delete jsonObj.dependencies.tslib;
  delete jsonObj.devDependencies['@willbooster/renovate-config'];
  delete jsonObj.devDependencies['@willbooster/tsconfig'];
  // Drop `@typescript/native-preview` (tsgo) here so non-Next.js repos never carry it;
  // this runs before applyPackageJsonConventions, which re-adds it for Next.js-family
  // repos that need it alongside the `typescript` v7 package for `next build`.
  delete jsonObj.dependencies[typescriptGoDependency];
  delete jsonObj.devDependencies[typescriptGoDependency];
  // Non-TypeScript repos should not keep a stray `typescript` package.
  if (!config.doesContainTypeScript && !config.doesContainTypeScriptInPackages) {
    delete jsonObj.dependencies[typescriptDependency];
    delete jsonObj.devDependencies[typescriptDependency];
  }
  delete jsonObj.devDependencies.lerna;
  // To install the latest pinst
  delete jsonObj.devDependencies.pinst;
  delete jsonObj.scripts['flutter-format'];
  delete jsonObj.scripts['format-flutter'];
  delete jsonObj.scripts['python-format'];
  delete jsonObj.scripts['format-python'];
  delete jsonObj.scripts.prettier;
  delete jsonObj.scripts['check-all'];
  delete jsonObj.scripts['verify-code'];
  delete jsonObj.scripts['verify-code-with-tests'];
  await promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'lerna.json'), { force: true }));

  removeWillBoosterConfigsManagedDependencies(config, jsonObj);
  removeObsoleteLintDependencies(jsonObj, config);
}

function removeSelfDependency(
  config: PackageConfig,
  jsonObj: SetRequired<PackageJson, 'dependencies' | 'devDependencies' | 'peerDependencies'>
): void {
  const packageName = jsonObj.name || path.basename(config.dirPath);

  // A package can import itself through Node's package self-reference without
  // declaring itself; keeping that edge breaks monorepo release topological sorting.
  for (const section of getDependencySections(jsonObj)) {
    Reflect.deleteProperty(section, packageName);
  }
}

function replaceWillBoosterConfigsWorkspaceDependencyRanges(config: PackageConfig, jsonObj: PackageJson): void {
  if (!config.isWillBoosterConfigs) return;

  for (const section of getDependencySections(jsonObj)) {
    for (const [dependency, version] of Object.entries(section)) {
      if (!version) continue;
      if (!isWorkspaceProtocolRange(version)) continue;
      // willbooster-configs publishes these packages independently, so generated
      // package metadata must describe npm release edges instead of local
      // workspace edges that release tooling treats as monorepo graph links.
      // The final `yarn install --no-immutable` syncs the lockfile after this
      // migration, even when the dependency is not part of wbfy's managed list.
      section[dependency] = getLatestDependencyVersion(config, dependency);
    }
  }
}

function removeWillBoosterConfigsManagedDependencies(
  config: PackageConfig,
  jsonObj: SetRequired<PackageJson, 'dependencies' | 'devDependencies' | 'peerDependencies'>
): void {
  if (!config.isWillBoosterConfigs) return;

  const sections = getDependencySections(jsonObj);
  for (const dependency of willBoosterConfigsManagedDependencies) {
    // willbooster-configs owns these config packages. Package-local formatter
    // and linter config files are repo tooling, not published package data, so
    // the package metadata only needs the formatter/linter executables.
    for (const section of sections) {
      Reflect.deleteProperty(section, dependency);
    }
  }
}

async function removeUnusedTsconfigBaseDependencies(
  config: PackageConfig,
  jsonObj: WritablePackageJson,
  usedDependencies: string[]
): Promise<void> {
  const usedDependencySet = new Set(usedDependencies);
  const existingTsconfigBaseDependencies = await getExistingTsconfigBaseDependencies(config);
  for (const dependency of managedTsconfigBaseDependencies) {
    if (usedDependencySet.has(dependency) || existingTsconfigBaseDependencies.has(dependency)) continue;
    // wbfy owns these base-config packages. Remove stale variants when repo
    // capabilities change, such as Next.js taking ownership of tsconfig.json.
    for (const section of getDependencySections(jsonObj)) {
      Reflect.deleteProperty(section, dependency);
    }
  }
}

async function getExistingTsconfigBaseDependencies(config: PackageConfig): Promise<Set<string>> {
  const existingTsconfigBaseDependencies = new Set<string>();
  const filePaths = await fg.glob('**/tsconfig*.json', {
    cwd: config.dirPath,
    dot: true,
    ignore: globIgnore,
  });

  for (const filePath of filePaths) {
    const absoluteFilePath = path.resolve(config.dirPath, filePath);
    // TypeScript 7's native compiler dropped the in-process `parseConfigFileTextToJson`
    // helper, so parse the tsconfig into an AST and read its top-level `extends` directly.
    const source = parseSourceFile(absoluteFilePath);
    if (!source) {
      console.warn(`Preserve managed @tsconfig dependencies because ${absoluteFilePath} could not be parsed.`);
      return new Set(managedTsconfigBaseDependencies);
    }
    for (const value of readTsconfigExtends(source)) {
      for (const dependency of managedTsconfigBaseDependencies) {
        if (value === dependency || value.startsWith(`${dependency}/`)) {
          existingTsconfigBaseDependencies.add(dependency);
        }
      }
    }
  }

  return existingTsconfigBaseDependencies;
}

/** Reads the top-level `extends` entries (a string or array of strings) from a parsed tsconfig. */
function readTsconfigExtends(source: ast.SourceFile): string[] {
  const values: string[] = [];
  for (const property of getTsconfigRootProperties(source)) {
    if (ast.isPropertyAssignment(property) && ast.isStringLiteral(property.name) && property.name.text === 'extends') {
      collectStringLiteralValues(property.initializer, values);
    }
  }
  return values;
}

function getTsconfigRootProperties(source: ast.SourceFile): readonly ast.ObjectLiteralElementLike[] {
  for (const statement of source.statements) {
    if (ast.isExpressionStatement(statement) && ast.isObjectLiteralExpression(statement.expression)) {
      return statement.expression.properties;
    }
  }
  return [];
}

function collectStringLiteralValues(node: ast.Expression, values: string[]): void {
  if (ast.isStringLiteral(node)) {
    values.push(node.text);
  } else if (ast.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      collectStringLiteralValues(element, values);
    }
  }
}

function getDependencySections(jsonObj: PackageJson): Partial<Record<string, string>>[] {
  return dependencySectionKeys
    .map((key) => jsonObj[key])
    .filter((section): section is Partial<Record<string, string>> => !!section);
}

function getLatestDependencyVersion(config: PackageConfig, dependency: string): string {
  const cacheKey = dependency;
  const cachedVersion = latestDependencyVersionCache.get(cacheKey);
  if (cachedVersion) return cachedVersion;

  const version = getDependencyVersionFromNpm(dependency);
  latestDependencyVersionCache.set(cacheKey, version);
  return version;
}

function getDependencyVersionFromNpm(dependency: string): string {
  // wbfy-managed tooling (preapproved packages) adopts the latest release immediately,
  // bypassing the minimum-release-age gate applied to unreviewed dependencies.
  if (!shouldApplyPackageAgeGate(dependency)) {
    return getRawDependencyVersionFromNpm(dependency);
  }

  return getLatestAgeGatedDependencyVersion(dependency, getPackageAgeGateMs());
}

function getLatestAgeGatedDependencyVersion(dependency: string, packageAgeGateMs: number): string {
  const times = getNpmPackageTimes(dependency);
  const latestVersion = getRawDependencyVersionFromNpm(dependency);
  if (latestVersion !== '*' && isPublishedBeforeAgeGate(times[latestVersion], packageAgeGateMs)) {
    return latestVersion;
  }

  const now = Date.now();
  const versions = Object.entries(times)
    .filter(([version]) => semver.valid(version))
    .filter(([version]) => (semver.prerelease(version)?.length ?? 0) === 0)
    .filter(([, publishedAt]) => Number.isFinite(Date.parse(publishedAt)))
    .filter(([, publishedAt]) => now - Date.parse(publishedAt) >= packageAgeGateMs)
    .toSorted(([versionA], [versionB]) => semver.rcompare(versionA, versionB));

  return versions[0]?.[0] ?? '*';
}

function isPublishedBeforeAgeGate(publishedAt: string | undefined, packageAgeGateMs: number): boolean {
  if (!publishedAt) return false;
  const publishedTime = Date.parse(publishedAt);
  return Number.isFinite(publishedTime) && Date.now() - publishedTime >= packageAgeGateMs;
}

function getNpmPackageTimes(dependency: string): Record<string, string> {
  const packageName = dependency.replace(/@[^@/]+$/u, '');
  const cachedTimes = npmPackageTimesCache.get(packageName);
  if (cachedTimes) return cachedTimes;

  const stdout = spawnSyncAndReturnStdout(
    'npm',
    ['show', packageName, 'time', '--json', '--workspaces=false'],
    process.cwd()
  );
  if (!stdout) return {};

  try {
    const parsed = JSON.parse(stdout) as Record<string, string>;
    npmPackageTimesCache.set(packageName, parsed);
    return parsed;
  } catch {
    return {};
  }
}

function shouldApplyPackageAgeGate(dependency: string): boolean {
  return !bunMinimumReleaseAgeExcludes.some((pattern) => doesPackagePatternMatch(pattern, dependency));
}

function getPackageAgeGateMs(): number {
  return bunMinimumReleaseAgeSeconds * 1000;
}

function doesPackagePatternMatch(pattern: string, dependency: string): boolean {
  if (pattern === dependency) return true;
  if (!pattern.includes('*')) return false;

  const escapedPattern = pattern.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`).replaceAll('*', '.*');
  return new RegExp(`^${escapedPattern}$`, 'u').test(dependency);
}

function getRawDependencyVersionFromNpm(dependency: string): string {
  return spawnSyncAndReturnStdout('npm', ['show', dependency, 'version', '--workspaces=false'], process.cwd()) || '*';
}

function getInstallDependencySpecifier(config: PackageConfig, dependency: string): string {
  if (dependency === wbDependency) return `${dependency}@${getLatestDependencyVersion(config, dependency)}`;
  return dependency;
}

function removeObsoleteLintDependencies(
  jsonObj: SetRequired<PackageJson, 'dependencies' | 'devDependencies' | 'peerDependencies'>,
  config: PackageConfig
): void {
  const preserveMicromatch = shouldPreserveMicromatch(config);
  for (const dependency of obsoleteLintDependencies) {
    if (preserveMicromatch && micromatchPackageNames.has(dependency)) continue;
    if (shouldPreserveConfigPackageLintDependency(jsonObj, config, dependency)) continue;
    delete jsonObj.dependencies[dependency];
    delete jsonObj.devDependencies[dependency];
    delete jsonObj.peerDependencies[dependency];
  }
}

function shouldPreserveConfigPackageLintDependency(
  jsonObj: SetRequired<PackageJson, 'dependencies' | 'devDependencies' | 'peerDependencies'>,
  config: PackageConfig,
  dependency: string
): boolean {
  if (!isPublishedWillboosterConfigsPackage(config)) return false;
  if (jsonObj.peerDependencies[dependency]) return true;

  // Published config packages need local type-only deps to validate the
  // package-provided config declarations under Yarn PnP.
  return dependency === '@types/eslint' && !!jsonObj.peerDependencies.eslint;
}

function shouldPreserveMicromatch(config: PackageConfig): boolean {
  // willbooster-configs subpackages publish config files as their product, so
  // micromatch is package data there. Other repos keep micromatch only when
  // product code imports it; otherwise it is treated as obsolete ESLint-era
  // tooling.
  return (config.isWillBoosterConfigs && !config.isRoot) || doesProductCodeImportMicromatch(config.dirPath);
}

function doesProductCodeImportMicromatch(dirPath: string): boolean {
  const filePaths = fg.globSync('src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}', {
    cwd: dirPath,
    dot: true,
    ignore: globIgnore,
  });
  return filePaths.some((filePath) => {
    try {
      return micromatchImportPattern.test(fs.readFileSync(path.resolve(dirPath, filePath), 'utf8'));
    } catch {
      return false;
    }
  });
}

const workspacePackageDirsCache = new Map<string, Map<string, string>>();

/** Map from each workspace package's name to its directory (relative to the monorepo root). */
export function getWorkspacePackageDirs(rootConfig: PackageConfig): Map<string, string> {
  const cached = workspacePackageDirsCache.get(rootConfig.dirPath);
  if (cached) return cached;

  const workspaceDirsByName = new Map<string, string>();
  for (const packageJsonPath of getWorkspacePackageJsonPaths(rootConfig)) {
    try {
      const workspacePackageJson = JSON.parse(
        fs.readFileSync(path.resolve(rootConfig.dirPath, packageJsonPath), 'utf8')
      ) as PackageJson;
      if (workspacePackageJson.name) {
        workspaceDirsByName.set(workspacePackageJson.name, path.posix.dirname(packageJsonPath));
      }
    } catch {
      // ignore unparsable workspace package.json
    }
  }
  workspacePackageDirsCache.set(rootConfig.dirPath, workspaceDirsByName);
  return workspaceDirsByName;
}

function shouldUpdateExistingManagedDependency(
  config: PackageConfig,
  dependency: string,
  currentVersion: string | undefined
): boolean {
  if (!currentVersion) return true;
  if (currentVersion === '*') return true;
  if (isWorkspaceProtocolRange(currentVersion)) return true;
  // wbfy owns these tool dependencies, but applying wbfy should not downgrade a
  // repository that already pins a newer reviewed release.
  return managedDependencyNames.has(dependency) && isNewerManagedDependencyVersion(config, dependency, currentVersion);
}

function isNewerManagedDependencyVersion(config: PackageConfig, dependency: string, currentVersion: string): boolean {
  const latestVersion = getLatestDependencyVersion(config, dependency);
  return isNewerPackageVersion(latestVersion, currentVersion);
}

function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
  const validLatestVersion = semver.valid(candidateVersion);
  const validCurrentVersion = semver.valid(currentVersion);
  return !validLatestVersion || !validCurrentVersion || semver.gt(validLatestVersion, validCurrentVersion);
}

function isWorkspaceProtocolRange(version: string): boolean {
  return version.startsWith('workspace:');
}

function formatRepositoryForPackageJson(
  repository: PackageJson['repository'],
  existingRepository?: PackageJson['repository']
): PackageJson['repository'] {
  const normalizedRepository = normalizeRepositoryUrlForPackageJson(repository);
  if (normalizedRepository) {
    return buildNormalizedRepositoryForPackageJson(normalizedRepository, repository, existingRepository);
  }

  const normalizedExistingRepository = normalizeRepositoryUrlForPackageJson(existingRepository);
  if (normalizedExistingRepository) {
    return buildNormalizedRepositoryForPackageJson(normalizedExistingRepository, existingRepository);
  }

  return repository;
}

function normalizeRepositoryUrlForPackageJson(repository: PackageJson['repository']): string | undefined {
  if (typeof repository === 'string') {
    if (!repository.startsWith('github:')) return;

    const [owner, repo] = gitHubUtil.getOrgAndName(repository);
    if (!owner || !repo) return;
    return `git+https://github.com/${owner}/${repo}.git`;
  }

  const repositoryUrl = repository?.url;
  if (typeof repositoryUrl !== 'string') return;

  const matched = /^(?:git\+)?https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(repositoryUrl);
  if (!matched) return;

  const [, owner, repo] = matched;
  return `git+https://github.com/${owner}/${repo}.git`;
}

function buildNormalizedRepositoryForPackageJson(
  normalizedUrl: string,
  repository: PackageJson['repository'],
  existingRepository?: PackageJson['repository']
): PackageJson['repository'] {
  const repositoryObj =
    typeof repository === 'object'
      ? repository
      : typeof existingRepository === 'object'
        ? existingRepository
        : undefined;

  return {
    ...repositoryObj,
    type: 'git',
    url: normalizedUrl,
  };
}

export function generateScripts(config: PackageConfig, oldScripts: PackageJson.Scripts): Record<string, string> {
  const hasTypecheck = config.doesContainTypeScript || config.doesContainTypeScriptInPackages;
  const scripts: Record<string, string> = {
    // No `--bun`: its node->bun PATH shim leaks into every child process and breaks tools
    // requiring real Node.js (Playwright, wrangler, vinext).
    cleanup: 'bun wb lint --fix --format',
    format: `bun wb lint --format`,
    lint: `bun wb lint`,
    'lint-fix': 'bun wb lint --fix',
    test: 'bun wb test',
    typecheck: 'bun wb typecheck',
    verify: 'bun wb verify',
    'verify-full': 'bun wb verify --full',
  };
  applyDatabaseScripts(config, scripts, oldScripts, `bun ${getWbDatabaseCommand(config)}`);
  applyMiseTaskScripts(config, scripts, oldScripts, ['build', 'dev', 'start', 'test', 'typecheck']);
  if (!hasTypecheck) {
    delete scripts.typecheck;
  } else if (config.depending.pyright) {
    scripts.typecheck += ' && pyright';
  }
  return scripts;
}

function shouldManageGenI18nTs(config: PackageConfig): boolean {
  return config.depending.genI18nTs && fs.existsSync(path.join(config.dirPath, 'i18n'));
}

function applyDatabaseScripts(
  config: PackageConfig,
  scripts: Record<string, string>,
  oldScripts: PackageJson.Scripts,
  wbDbCommand: string
): void {
  if (!config.depending.prisma && !config.depending.drizzle) return;

  applyDatabaseScript(scripts, oldScripts, 'db-create-migration', `${wbDbCommand} migrate-dev`, /migrate-dev/u);
  applyDatabaseScript(
    scripts,
    oldScripts,
    'db-migrate',
    `${wbDbCommand} migrate --check-idempotency`,
    /migrate(?:[ \t]+--check-idempotency)?/u
  );
  applyDatabaseScript(scripts, oldScripts, 'db-view', `${wbDbCommand} studio`, /studio/u);
}

function applyDatabaseScript(
  scripts: Record<string, string>,
  oldScripts: PackageJson.Scripts,
  name: string,
  generatedScript: string,
  generatedArgsPattern: RegExp
): void {
  const oldScript = oldScripts[name];
  // Some repositories wrap migration commands to prepare SQLite directories,
  // fan out over tenants, or perform cleanup that wb cannot infer generically.
  scripts[name] =
    oldScript && !isGeneratedDatabaseScript(oldScript, generatedArgsPattern) ? oldScript : generatedScript;
}

/**
 * Whether a script body is one of the KNOWN generated `wb db`/`wb prisma` invocations FOR THE
 * GIVEN managed script (allowing legacy runner prefixes, including the historical `bun --bun`,
 * and that script's historical argument variants such as `migrate` without `--check-idempotency`).
 * Anchored on the WHOLE body AND on the exact generated argument list so a custom wrapper that
 * merely contains a wb call (`prepare-sqlite && WB_ENV=… wb db studio`), carries extra flags
 * (`wb prisma studio --port 5556`), or reuses another managed script's command
 * (`"db-migrate": "wb db migrate-dev"`) is preserved instead of being replaced wholesale.
 */
function isGeneratedDatabaseScript(script: string, generatedArgsPattern: RegExp): boolean {
  // Horizontal whitespace only ([ \t]) — a newline is a shell command separator, so a
  // newline-containing body is a multi-command wrapper that must be preserved.
  return new RegExp(
    String.raw`^(?:(?:bun(?:[ \t]+--bun)?|yarn|npx)[ \t]+)?wb[ \t]+(?:db|prisma)[ \t]+(?:${generatedArgsPattern.source})$`,
    'u'
  ).test(script.trim());
}

function getWbDatabaseCommand(config: PackageConfig): 'wb db' | 'wb prisma' {
  if (config.depending.prisma) return 'wb prisma';
  return 'wb db';
}

function isWbPackage(packageJson: PackageJson | undefined): boolean {
  return packageJson?.name === wbDependency;
}

function applyMiseTaskScripts(
  config: PackageConfig,
  scripts: Record<string, string>,
  oldScripts: PackageJson.Scripts,
  names: string[]
): void {
  for (const name of names) {
    if (!hasMiseTask(config, name)) continue;
    if (doesMiseTaskCallPackageScript(config, name)) continue;
    // Preserve a leading `KEY=VALUE ` env prefix (e.g. `MISE_ENV=test`) on an existing mise bridge.
    // Such a prefix is required for mise config environments (mise.<MISE_ENV>.toml), which are
    // selected from MISE_ENV *before* mise starts and cannot be switched from inside a task; dropping
    // it would silently run the task in the default environment.
    const envPrefix = extractMiseBridgeEnvPrefix(oldScripts[name], name);
    if (envPrefix === undefined && oldScripts[name] && !(name in scripts)) continue;
    scripts[name] = `${envPrefix ?? ''}mise run ${name}`;
  }
}

/**
 * Returns the leading `KEY=VALUE ` env-var prefix of an existing `mise run <name>` bridge script
 * (possibly an empty string when the bridge has no prefix), or `undefined` when the script is not a
 * mise bridge for the given task.
 */
function extractMiseBridgeEnvPrefix(script: unknown, name: string): string | undefined {
  if (typeof script !== 'string') return undefined;
  // Each assignment value may be double-quoted, single-quoted, or an unquoted run of non-whitespace,
  // so prefixes like `MISE_ENV="a b"` (whose value contains spaces) are matched instead of dropped.
  const match = new RegExp(String.raw`^((?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)*)mise run ${escapeRegExp(name)}$`, 'u').exec(
    script.trim()
  );
  return match?.[1];
}

function hasMiseTask(config: PackageConfig, name: string): boolean {
  return Object.hasOwn(config.miseTasks, name);
}

function doesMiseTaskCallPackageScript(config: PackageConfig, name: string): boolean {
  const task = config.miseTasks[name];
  if (!task) return false;
  const packageManagers = ['bun', 'yarn', 'npm', 'pnpm'];
  return packageManagers.some((packageManager) =>
    new RegExp(String.raw`\b${packageManager}\s+(?:run\s+)?${escapeRegExp(name)}(?![a-zA-Z0-9_\-:.])`, 'u').test(task)
  );
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function removePrettierArtifacts(jsonObj: WritablePackageJson): void {
  delete jsonObj.prettier;
  const dependencySections: Array<Partial<Record<string, string>> | undefined> = [
    jsonObj.dependencies,
    jsonObj.devDependencies,
    jsonObj.peerDependencies,
  ];
  for (const section of dependencySections) {
    if (!section) continue;
    delete section.prettier;
    delete section['prettier-plugin-java'];
    delete section['prettier-plugin-prisma'];
    delete section['@willbooster/prettier-config'];
    delete section['@types/prettier'];
  }
}

async function updatePrivatePackages(jsonObj: WritablePackageJson): Promise<void> {
  const packageNames = new Set([...Object.keys(jsonObj.dependencies), ...Object.keys(jsonObj.devDependencies)]);
  const privatePackages: {
    packageName: string;
    org: string;
    repo: string;
    target: 'dependencies' | 'devDependencies';
  }[] = [
    { packageName: '@willbooster/code-analyzer', org: 'WillBooster', repo: 'code-analyzer', target: 'devDependencies' },
    { packageName: '@willbooster/judge', org: 'WillBoosterLab', repo: 'judge', target: 'dependencies' },
    { packageName: '@willbooster/llm-proxy', org: 'WillBoosterLab', repo: 'llm-proxy', target: 'dependencies' },
  ];

  await Promise.all(
    privatePackages.map(async ({ org, packageName, repo, target }) => {
      if (!packageNames.has(packageName) || isWorkspacePackage(jsonObj, packageName)) return;

      const existingSpecifier = jsonObj.dependencies[packageName] ?? jsonObj.devDependencies[packageName];
      const otherTarget = target === 'dependencies' ? 'devDependencies' : 'dependencies';
      // The lint rule disallows `delete` with computed package names; Reflect has the same deletion semantics here.
      Reflect.deleteProperty(jsonObj[otherTarget], packageName);
      jsonObj[target][packageName] = isPinnedPrivatePackageSpecifier(existingSpecifier, org, repo)
        ? existingSpecifier
        : await getLatestPrivatePackageSpecifier(org, repo);
    })
  );
}

/**
 * Whether the existing specifier already pins a git ref of the expected private repository.
 * wbfy must not bump such pins: a run intended as configuration/package-manager maintenance
 * would otherwise change the dependency's version as a side effect (updating pins is Renovate's
 * job), possibly to a commit whose prebuilt artifacts are missing.
 */
function isPinnedPrivatePackageSpecifier(
  specifier: string | undefined,
  org: string,
  repo: string
): specifier is string {
  if (!specifier) return false;
  return new RegExp(String.raw`(?:^|[:/])${org}/${repo}(?:\.git)?#\S+$`, 'u').test(specifier);
}

async function getLatestPrivatePackageSpecifier(org: string, repo: string): Promise<string> {
  const commitHash = await getLatestCommitHash(org, repo);
  return `git@github.com:${org}/${repo}.git#${commitHash}`;
}

function isWorkspacePackage(jsonObj: PackageJson, packageName: string): boolean {
  return (jsonObj.devDependencies?.[packageName] || jsonObj.dependencies?.[packageName] || '').includes('workspace');
}
