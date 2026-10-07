// GitHub Actions valueless events such as `pull_request:` require YAML null values.
/* eslint-disable unicorn/no-null */

import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import * as yaml from 'js-yaml';

import { logger } from '../logger.js';
import { hasFnoxSyncFailed, resolveFnoxCiAgeKeySecretName } from './fnoxToml.js';
import { fsUtil } from '../utils/fsUtil.js';
import type { PackageConfig } from '../packageConfig.js';
import { combineMerge } from '../utils/mergeUtil.js';
import { moveToBottom, sortKeys } from '../utils/objectUtil.js';
import { repoResolvesPrivatePackages } from '../utils/privatePackages.js';
import { isSkippedReleaseCaller, parseOrgReusableWorkflowCall } from '../utils/orgReusableWorkflowCall.js';
import { runAllInPool } from '../utils/promisePool.js';
import { parseShellCommands } from '../utils/shellParser.js';
import { dumpYamlOver } from '../utils/yamlUtil.js';
import { assertPrivateWorkflowRunners, selfHostedRunnerInputSchema } from './workflowRunnerPolicy.js';

interface Workflow {
  name?: string;
  on?: On;
  concurrency?: Concurrency;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

interface Concurrency {
  group: string;
  'cancel-in-progress': boolean;
  queue?: 'single' | 'max';
}

interface On {
  // GitHub Actions treats `event: null` as a valueless event mapping, e.g.
  // `pull_request:`. `undefined` would omit the event entirely when dumping YAML.
  issues?: Types | null;
  pull_request?: PullRequest | null;
  pull_request_target?: Types | null;
  push?: Push;
  schedule?: Schedule[];
  workflow_dispatch?: null;
}

interface PullRequest {
  'paths-ignore'?: string[];
  types?: string[];
}

interface Push {
  branches: string[];
  'paths-ignore'?: string[];
}

interface Schedule {
  cron: string;
}

interface Types {
  types: string[];
}

interface Job {
  'runs-on'?: string;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: Step[];
  uses?: string;
  if?: string;
  secrets?: Record<string, unknown> | 'inherit';
  with?: Record<string, unknown>;
}

interface Step {
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}

const workflows = {
  test: {
    name: 'Test',
    on: {
      pull_request: null,
      push: {
        branches: ['main'],
      },
      // Let maintainers re-run the tests by hand.
      workflow_dispatch: null,
    },
    // cf. https://docs.github.com/en/actions/using-jobs/using-concurrency#example-only-cancel-in-progress-jobs-or-runs-for-the-current-workflow
    concurrency: {
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    },
    // None of these may be narrowed just because the reusable test workflow never pushes:
    permissions: {
      // for the test job's skip-duplicate-actions call with cancel_others: true (the reusable
      // test workflow declares no permissions of its own, so its jobs run on this token)
      actions: 'write',
      // for `semantic-release --dry-run`, which does a `git push --dry-run` to verify write
      // access and aborts with EGITNOPERMISSION without it
      contents: 'write',
      // for pkg-preflight PR file listing
      'pull-requests': 'read',
    },
    jobs: {
      test: {
        uses: 'WillBooster/reusable-workflows/.github/workflows/test.yml@main',
      },
    },
  },
  'test-rust': {
    name: 'Test Rust',
    on: {
      pull_request: null,
      push: {
        branches: ['main'],
      },
    },
    concurrency: {
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    },
    jobs: {
      'test-rust': {
        uses: 'WillBooster/reusable-workflows/.github/workflows/test-rust.yml@main',
      },
    },
  },
  release: {
    name: 'Release',
    on: {
      push: {
        branches: [],
      },
    },
    // `queue: max` here too (#974): GitHub's default queue (`single`) cancels an already-PENDING
    // caller run when another one queues — before its job (and the reusable workflow's own
    // job-level `queue: max`) ever starts — silently dropping that release trigger.
    // The caller-level group must NOT reuse the reusable workflow's job-level group name
    // (`release-${{ github.repository }}`): workflow-level and job-level groups share one
    // repository-wide namespace, and identical names deadlock the run ("Canceling since a
    // deadlock for concurrency group ... was detected between 'top level workflow' and '<job>'").
    concurrency: {
      group: '${{ github.workflow }}',
      'cancel-in-progress': false,
      queue: 'max',
    },
    permissions: {
      // https://docs.npmjs.com/trusted-publishers#step-2-configure-your-cicd-workflow
      'id-token': 'write',
      // for semantic-release
      contents: 'write',
    },
    jobs: {
      release: {
        uses: 'WillBooster/reusable-workflows/.github/workflows/release.yml@main',
      },
    },
  },
  'semantic-pr': {
    name: 'Lint PR title',
    on: {
      pull_request_target: {
        types: ['opened', 'edited', 'synchronize'],
      },
    },
    jobs: {
      'semantic-pr': {
        uses: 'WillBooster/reusable-workflows/.github/workflows/semantic-pr.yml@main',
      },
    },
  },
  sync: {
    name: 'Sync',
    on: {},
    permissions: {
      // for commiting changes
      contents: 'write',
    },
    jobs: {
      sync: { uses: 'WillBooster/reusable-workflows/.github/workflows/sync.yml@main' },
    },
  },
} as const;

type KnownKind = keyof typeof workflows | 'deploy';

export async function generateWorkflows(rootConfig: PackageConfig): Promise<void> {
  if (!rootConfig.isRepoVisibilityKnown) {
    console.warn('Skipped workflow generation because repository visibility is unknown.');
    return;
  }
  const workflowsPath = path.resolve(rootConfig.dirPath, '.github', 'workflows');
  if (!isReusableWorkflowsRepo(rootConfig.repository) && (await fsUtil.isConfinedWritablePath(workflowsPath))) {
    await assertPrivateWorkflowRunners(rootConfig, workflowsPath);
  }
  return logger.functionIgnoringException('generateWorkflow', async () => {
    if (isReusableWorkflowsRepo(rootConfig.repository)) {
      // Don't touch reusable-workflows repo because it hosts upstream workflow definitions.
      return;
    }

    // With .github or .github/workflows symlinked outside the repository, writeYaml's guards
    // already refuse the writes, but readdir/rm below would still enumerate and DELETE files
    // outside the repository — so require the directory to resolve inside it before any
    // traversal, mkdir, or cleanup.
    if (!(await fsUtil.isConfinedWritablePath(workflowsPath))) {
      console.warn(`Skipped generating workflows because ${workflowsPath} resolves outside the repository.`);
      return;
    }
    await fs.promises.mkdir(workflowsPath, { recursive: true });

    const fileNamesByKind = await collectWorkflowFileNamesByKind(rootConfig, workflowsPath);
    await runAllInPool(
      // 実際はKnownKind以外の値も代入されることに注意
      [...fileNamesByKind].map(
        ([kind, fileName]) =>
          () =>
            writeWorkflowYaml(rootConfig, workflowsPath, kind as KnownKind, fileName)
      )
    );
  });
}

/** Maps each workflow kind to generate to its file, deleting generated callers that no longer apply. */
async function collectWorkflowFileNamesByKind(
  rootConfig: PackageConfig,
  workflowsPath: string
): Promise<Map<string, string>> {
  const entries = await fs.promises.readdir(workflowsPath, { withFileTypes: true });
  // wbfy writes .yml workflows, so each kind maps to its .yml file.
  const fileNamesByKind = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.yml')) continue;
    fileNamesByKind.set(entry.name.slice(0, -'.yml'.length), entry.name);
  }
  const mandatoryKinds = ['test', 'semantic-pr'];
  if (rootConfig.depending.semanticRelease) {
    mandatoryKinds.push('release');
  }
  if (rootConfig.cargoTomlDirPaths.length > 0) {
    mandatoryKinds.push('test-rust');
  } else {
    // A previous run may have mistaken a gitignored third-party checkout for repository Rust code.
    await removeGeneratedCaller(workflowsPath, fileNamesByKind, 'test-rust');
  }
  await removeGeneratedCaller(workflowsPath, fileNamesByKind, 'close-comment');
  fileNamesByKind.delete('wbfy');
  for (const kind of mandatoryKinds) {
    if (!fileNamesByKind.has(kind)) {
      fileNamesByKind.set(kind, `${kind}.yml`);
    }
  }
  if (fileNamesByKind.has('sync')) {
    // The sync workflow's generation owns the force-sync workflow, so processing it as an
    // independent kind would race concurrent writes on the same path.
    fileNamesByKind.delete('sync-force');
  }
  return fileNamesByKind;
}

// Removes only the generated-style caller: a same-named custom workflow with any other job stays.
async function removeGeneratedCaller(
  workflowsPath: string,
  fileNamesByKind: Map<string, string>,
  kind: string
): Promise<void> {
  const fileName = fileNamesByKind.get(kind);
  if (fileName && jobsAllCallReusableWorkflow(workflowsPath, fileName, kind)) {
    fileNamesByKind.delete(kind);
    await fsUtil.removeConfined(path.join(workflowsPath, fileName));
  }
}

export function isReusableWorkflowsRepo(repository?: string): boolean {
  // Case-insensitive: GitHub repository names are, and a remote may spell this one any way. Getting it wrong
  // lets wbfy rewrite the repository that hosts the upstream workflow definitions.
  return repository?.toLowerCase().endsWith('/reusable-workflows') ?? false;
}

/**
 * Whether every job of the workflow file calls the named WillBooster reusable workflow (owner
 * restricted via parseOrgReusableWorkflowCall). Used to decide whether wbfy owns a file enough to
 * delete it: unparsable files and files with any other job return false — deleting a whole
 * workflow on a loose match would be too aggressive.
 */
export function jobsAllCallReusableWorkflow(workflowsPath: string, fileName: string, workflowName: string): boolean {
  if (!fileName.endsWith('.yml')) return false;
  let content: string;
  try {
    content = fs.readFileSync(path.join(workflowsPath, fileName), 'utf8');
  } catch {
    return false;
  }
  const isTargetCall = (uses: unknown): boolean =>
    typeof uses === 'string' && parseOrgReusableWorkflowCall(uses)?.workflowName === workflowName;
  try {
    const workflow = yaml.load(content) as Workflow | undefined;
    if (workflow && typeof workflow === 'object' && workflow.jobs && typeof workflow.jobs === 'object') {
      const jobs = Object.values(workflow.jobs);
      return jobs.length > 0 && jobs.every((job) => isTargetCall(job?.uses));
    }
  } catch {
    // Unparsable content is not provably a caller of the named workflow.
  }
  return false;
}

async function writeWorkflowYaml(
  config: PackageConfig,
  workflowsPath: string,
  kind: KnownKind,
  fileName = `${kind}.yml`
): Promise<void> {
  const filePath = path.join(workflowsPath, fileName);
  const deployProductionFileName = fs.existsSync(path.join(workflowsPath, 'deploy-production.yml'))
    ? 'deploy-production.yml'
    : undefined;

  // A non-generated test-rust.yml in a repo without Rust code merely shares the name; leave it alone.
  if (kind === 'test-rust' && config.cargoTomlDirPaths.length === 0) return;

  const template = structuredClone(kind in workflows ? workflows[kind as keyof typeof workflows] : {}) as Workflow;
  const oldContent = await fsUtil.readFileIfExists(filePath);
  let newSettings =
    oldContent === undefined ? template : mergeExistingWorkflow(config, kind, filePath, template, oldContent);
  if (!newSettings || !('jobs' in newSettings)) return;

  if (kind.startsWith('deploy')) {
    newSettings = {
      ...newSettings,
      // Unlike the release caller, the default queue (`single`) is intentional here: a pending
      // deploy that is cancelled and replaced by a newer one loses nothing — the newer deploy
      // converges the environment to the latest state anyway.
      concurrency: {
        group: '${{ github.workflow }}',
        'cancel-in-progress': false,
      },
    };
    moveToBottom(newSettings, 'jobs');
  }

  if (kind === 'release' && newSettings.jobs.release && deployProductionFileName) {
    newSettings.permissions ??= {};
    newSettings.permissions.actions = 'write';
    newSettings.jobs.release.with ??= {};
    newSettings.jobs.release.with.trigger_deploy_workflow = deployProductionFileName;
  }

  if (!normalizeOrgReusableWorkflowJobs(config, newSettings.jobs, kind)) return;
  addReadOnlyPermissionsToDeployJobs(newSettings);

  if (kind === 'release' && !normalizeReleaseWorkflow(config, newSettings)) {
    await fsUtil.removeConfined(filePath);
    return;
  }
  if (kind === 'test' || kind === 'test-rust') {
    removeTestPathFilters(newSettings);
  }
  await writeYaml(newSettings, filePath);

  if (kind === 'sync') {
    await writeSyncForceWorkflow(newSettings, workflowsPath);
  }
}

/** Returns the template merged over the existing workflow, or undefined when the file must stay untouched. */
function mergeExistingWorkflow(
  config: PackageConfig,
  kind: KnownKind,
  filePath: string,
  template: Workflow,
  oldContent: string
): Workflow | undefined {
  let oldSettings: Workflow;
  try {
    oldSettings = yaml.load(oldContent) as Workflow;
  } catch {
    // An existing workflow wbfy cannot parse must be left untouched: writing the template
    // without merging would silently discard the repository's workflow.
    console.warn(`Skipped generating ${filePath} because the existing content is not parsable as YAML.`);
    return undefined;
  }
  // yaml.load returns undefined for empty/comment-only files and non-objects for scalar
  // documents without throwing; deepmerge would crash on them.
  if (typeof oldSettings !== 'object' || oldSettings === null || Array.isArray(oldSettings)) {
    console.warn(`Skipped generating ${filePath} because the existing content is not a workflow.`);
    return undefined;
  }
  const existingJob = oldSettings.jobs?.[kind];
  if (template.jobs?.[kind]?.uses && existingJob && !parseOrgReusableWorkflowCall(existingJob.uses)) {
    return undefined;
  }
  if (kind === 'release' && existingJob && isSkippedReleaseCaller(config.repoAuthor, existingJob.uses)) {
    return undefined;
  }
  return merge.all([template, oldSettings, template], { arrayMerge: combineMerge }) as Workflow;
}

/** Normalizes every job calling an organization reusable workflow and returns whether any exists. */
function normalizeOrgReusableWorkflowJobs(config: PackageConfig, jobs: Workflow['jobs'], kind: KnownKind): boolean {
  let isReusableWorkflow = false;
  for (const job of Object.values(jobs)) {
    // Ignore empty jobs (a bare `jobName:` parses as null), non-reusable workflows, and other
    // organizations' reusable workflows: a same-named `reusable-workflows` repository elsewhere
    // follows a different contract, and normalizing its callers (secret injection/removal,
    // permissions) could break them.
    if (!job || !parseOrgReusableWorkflowCall(job.uses)) continue;

    normalizeJob(config, job, kind);
    isReusableWorkflow = true;
  }
  return isReusableWorkflow;
}

// Deploy callers need no repository writes: the called reusable workflow inherits the caller's
// token permissions, repositories default the token to write, and the reusable deploy workflow
// at main performs no GITHUB_TOKEN writes. The read-only default is injected at the JOB level
// (job permissions do not affect sibling jobs, so inline jobs or pinned callees — whose write
// needs are unaudited — keep theirs), and only when neither the workflow nor the job declares
// its own permissions (OIDC deploys always do, for id-token). run-script callers are excluded
// because arbitrary package scripts may push commits.
function addReadOnlyPermissionsToDeployJobs(settings: Workflow): void {
  if (settings.permissions) return;
  for (const job of Object.values(settings.jobs)) {
    if (!job) continue;
    const call = parseOrgReusableWorkflowCall(job.uses);
    if (!job.permissions && call?.workflowName === 'deploy' && call.ref === 'main') {
      job.permissions = { contents: 'read' };
    }
  }
}

/** Returns false when no trigger remains, in which case the release workflow must be removed. */
function normalizeReleaseWorkflow(config: PackageConfig, settings: Workflow): boolean {
  if (settings.on?.schedule) {
    delete settings.on.push;
  } else if (settings.on?.push && config.release.branches.length > 0) {
    settings.on.push.branches = config.release.branches;
  } else {
    return false;
  }
  if (config.isPublicRepo) {
    settings.permissions ??= {};
    settings.permissions['id-token'] = 'write';
  } else {
    delete settings.permissions?.['id-token'];
  }
  return true;
}

// Don't use `paths-ignore` for test because GitHub's Branch Protection and Rulesets require job running.
function removeTestPathFilters(settings: Workflow): void {
  if (settings.on?.pull_request) {
    delete settings.on.pull_request['paths-ignore'];
  }
  if (settings.on?.push) {
    delete settings.on.push['paths-ignore'];
    settings.on.push.branches = settings.on.push.branches.filter((branch) => branch !== 'renovate/**');
  }
}

/** Generates the force-sync workflow from the already written sync workflow, consuming `syncSettings`. */
async function writeSyncForceWorkflow(syncSettings: Workflow, workflowsPath: string): Promise<void> {
  if (!syncSettings.jobs.sync?.with) return;

  syncSettings.jobs['sync-force'] = syncSettings.jobs.sync;
  const params = syncSettings.jobs.sync.with.sync_params_without_dest;
  if (typeof params !== 'string') return;

  syncSettings.jobs.sync.with.sync_params_without_dest = `--force ${params}`;
  syncSettings.name = 'Force to Sync';
  syncSettings.on = { workflow_dispatch: null };
  delete syncSettings.jobs.sync;
  await writeYaml(syncSettings, path.join(workflowsPath, 'sync-force.yml'));
}

// wb's global options that consume a following value token (from sharedOptionsBuilder plus
// yargsOptionsBuilderForEnv); every other `-`-prefixed token before the subcommand is a boolean.
const wbGlobalValueOptions = new Set(['--working-dir', '-w', '--env', '--cascade-env']);

// Subcommands that run a BINARY (so the following token can be the wb executable), per runner: bun
// reserves only `x` (`bun dlx`/`bun exec` run a package script of that name), npm has `exec`/`x`,
// and pnpm/yarn (Berry) have `exec`/`dlx`.
const runnerExecutorSubcommandsByRunner: Record<string, Set<string>> = {
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['exec', 'dlx']),
  yarn: new Set(['exec', 'dlx']),
  bun: new Set(['x']),
};

// Runner options that consume the FOLLOWING token as their value, so it is not the wb executable
// (e.g. `bun --cwd dir wb deploy`, `npx -p pkg wb deploy`). A conservative superset across
// npm/pnpm/yarn/bun and the npx/bunx package executors.
const runnerValueOptions = new Set([
  '--cwd',
  '-C',
  '--prefix',
  '--filter',
  '-F',
  '--workspace',
  '-w',
  '--dir',
  '-p',
  '--package',
  '-c',
  '--call',
]);

/** Advance past a runner's options, consuming a separate value token where one applies. */
function skipRunnerOptions(tokens: string[], startIndex: number): number {
  let index = startIndex;
  while (index < tokens.length && (tokens[index] ?? '').startsWith('-')) {
    const option = tokens[index] ?? '';
    index++;
    if (!option.includes('=') && runnerValueOptions.has(option) && index < tokens.length) index++;
  }
  return index;
}

/**
 * Whether a deploy script invokes `wb … deploy` at command position. Package runners and global yargs options
 * (with their value tokens) may precede the deploy command.
 */
export function invokesWbDeploy(deployScript: string, scriptNames: ReadonlySet<string>): boolean {
  for (const tokens of parseShellCommands(deployScript) ?? []) {
    if (commandInvokesWbDeploy(tokens, scriptNames)) return true;
  }
  return false;
}

function commandInvokesWbDeploy(tokens: string[], scriptNames: ReadonlySet<string>): boolean {
  const commandIndex = skipCommandBuiltins(tokens, skipEnvLauncher(tokens));
  if (commandIndex === undefined) return false;
  const executableIndex = skipPackageRunner(tokens, commandIndex, scriptNames);
  if (executableIndex === undefined || tokens[executableIndex] !== 'wb') return false;
  return isWbDeployInvocation(tokens.slice(executableIndex + 1));
}

// Leading launchers run the following command: `env` (with options + KEY=value assignments)
// and the POSIX `command` builtin (with its `-p`/`-v`/`-V` options). The grammar parses the
// `time` keyword as a wrapper, so `time wb deploy` already yields `wb` first. Other launchers
// (`exec`, `nice`, …) are NOT modeled: they leave a non-`wb` first token, so the command simply
// does not match. This is a deliberate false-negative for generated guidance.
function skipEnvLauncher(tokens: string[]): number {
  if (tokens[0] !== 'env') return 0;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) index++;
    // env's directory value may be separate or attached (`-Cdir`, `--chdir=dir`). It changes
    // where wb runs but not whether the command invokes wb deploy.
    else if (token === '-C' || token === '--chdir') index += 2;
    else if (token.startsWith('-C') || token.startsWith('--chdir=')) index++;
    else if (token === '-u') index += 2;
    else if (token.startsWith('-')) index++;
    else break;
  }
  return index;
}

/**
 * Returns the index after leading `command` builtins, or undefined when one only queries.
 *
 * `command CMD` executes CMD, but `command -v`/`-V CMD` only QUERY its availability without
 * running it, so a deploy behind them does not run. The `v`/`V` flag may be clustered with
 * other option letters (`command -pv wb`), so match any option letter cluster containing it.
 */
function skipCommandBuiltins(tokens: string[], startIndex: number): number | undefined {
  let index = startIndex;
  while (tokens[index] === 'command') {
    index++;
    while (index < tokens.length && (tokens[index] ?? '').startsWith('-')) {
      if (/^-[A-Za-z]*[vV][A-Za-z]*$/u.test(tokens[index] ?? '')) return undefined;
      index++;
    }
  }
  return index;
}

/**
 * Returns the index of the binary a leading package runner executes, or undefined when it runs a
 * package script instead.
 *
 * `bunx`/`npx` and `<pm> x|dlx|exec` run a binary; `<pm> run|run-script` (and bare `npm <name>`,
 * or any runner followed by `--`) run a package script — so `npm run wb deploy` executes the
 * script named `wb`, not the wb binary, and must be rejected.
 */
function skipPackageRunner(tokens: string[], startIndex: number, scriptNames: ReadonlySet<string>): number | undefined {
  const runner = tokens[startIndex] ?? '';
  if (['bunx', 'npx'].includes(runner)) return skipRunnerOptions(tokens, startIndex + 1);
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(runner)) return startIndex;

  const index = skipRunnerOptions(tokens, startIndex + 1);
  const subcommand = tokens[index] ?? '';
  if (['run', 'run-script'].includes(subcommand)) return undefined;
  // Executor subcommands are runner-SPECIFIC: bun reserves only `x` (`bun dlx`/`bun exec` run a
  // package script named dlx/exec). Real built-in executors (`exec`/`x`, and `dlx` for pnpm)
  // take precedence over a same-named script, so they are NOT shadow-checked. Only `yarn dlx` is
  // ambiguous — a Berry built-in but a package SCRIPT in Yarn Classic — so a declared `dlx`
  // script makes `yarn dlx` decline (fall through to the package-script checks).
  const isYarnDlxShadowedByScript = runner === 'yarn' && subcommand === 'dlx' && scriptNames.has('dlx');
  if (runnerExecutorSubcommandsByRunner[runner]?.has(subcommand) && !isYarnDlxShadowedByScript) {
    // Binary runner (pnpm dlx, bun x, `npm exec -- wb …`), with the executor's optional `--` before the command.
    return tokens[index + 1] === '--' ? index + 2 : index + 1;
  }
  // Bare `npm wb` never runs a binary.
  if (runner === 'npm') return undefined;
  // Bare `bun/pnpm/yarn wb` runs a package SCRIPT named `wb` when one exists (passing `deploy`
  // as its argument), not the wb binary.
  if (tokens[index] === 'wb' && scriptNames.has('wb')) return undefined;
  return index;
}

// Skip global options (and any value token a value-bearing option consumes) so the FIRST
// command token decides: `wb --cascade-env production deploy` and `wb -w packages/api deploy`
// match, while subcommands owning their own `deploy` (`wb prisma deploy`, `wb retry deploy`)
// do not. `--opt=value` carries its value inline, so only the space-separated form skips one.
function isWbDeployInvocation(wbArgs: string[]): boolean {
  let commandIndex = 0;
  while (commandIndex < wbArgs.length && (wbArgs[commandIndex] ?? '').startsWith('-')) {
    const flag = wbArgs[commandIndex] ?? '';
    commandIndex++;
    if (wbGlobalValueOptions.has(flag) && commandIndex < wbArgs.length) commandIndex++;
  }
  return wbArgs[commandIndex] === 'deploy';
}

/**
 * Whether the workflows directory holds a live caller of the reusable Cloudflare deploy workflow.
 * YAML is parsed and only `jobs.*.uses` values are inspected (a raw-text search would match
 * comments or `run:` strings), with a `deploy*`-filename shortcut and a conservative raw-text
 * fallback for unparseable files. Used by the agent-instruction generator so generated guidance
 * describes only workflows that exist.
 */
export function hasCloudflareDeployWorkflow(workflowsDirPath: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workflowsDirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  // Case-insensitive owner/repository (GitHub treats them so), case-sensitive path/ref — matching
  // parseOrgReusableWorkflowCall, used for the unparseable-YAML raw-text fallback only.
  const deployCallPattern = /[^/]+\/reusable-workflows\/\.github\/workflows\/deploy\.ya?ml@/iu;
  return entries.some((entry) => {
    if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name)) return false;
    if (entry.name.startsWith('deploy')) return true;
    let content: string;
    try {
      content = fs.readFileSync(path.join(workflowsDirPath, entry.name), 'utf8');
    } catch {
      return false;
    }
    try {
      const workflow = yaml.load(content) as Workflow | undefined;
      if (workflow && typeof workflow === 'object' && workflow.jobs && typeof workflow.jobs === 'object') {
        return Object.values(workflow.jobs).some(
          (job) => parseOrgReusableWorkflowCall(job?.uses)?.workflowName === 'deploy'
        );
      }
      return false;
    } catch {
      return deployCallPattern.test(content);
    }
  });
}

// The reusable workflows that declare FNOX_AGE_KEY and VERDACCIO_TOKEN under
// on.workflow_call.secrets (see WillBooster/reusable-workflows). Passing either secret to any
// other callee is a GitHub error.
const installCapableReusableWorkflows = new Set(['deploy', 'release', 'run-script', 'test']);
const reusableWorkflowPermissions: Record<string, Record<string, string>> = {
  // skip-duplicate-actions reads workflow runs; cancel_others is false, so read is enough.
  'test-rust': { actions: 'read', contents: 'read' },
  'semantic-pr': { 'pull-requests': 'read', statuses: 'write' },
};

function normalizeJob(config: PackageConfig, job: Job, kind: KnownKind): void {
  job.with ??= {};
  // `secrets: inherit` (parsed by js-yaml as a plain string) already forwards every caller secret
  // including the ones injected below, so preserve it untouched — property assignments on the
  // string would throw. Caveat: `inherit` forwards secrets under their existing NAMES, so it can
  // never feed PUBLIC_FNOX_AGE_KEY into the callee's declared FNOX_AGE_KEY; a hand-written
  // inherit caller in a PUBLIC fnox repository must be converted to an explicit mapping manually
  // (wbfy never generates the inherit form, and hand-written deviations are fixed in the target
  // repository by policy).
  const secrets = job.secrets === 'inherit' ? undefined : (job.secrets = job.secrets ?? {});

  if (secrets && (kind === 'test' || kind === 'release')) {
    secrets.GH_TOKEN = '${{ secrets.GITHUB_TOKEN }}';
  }

  // fnox.toml carries age-encrypted app secrets; CI decrypts them with the FNOX_AGE_KEY (or, for
  // public repositories, PUBLIC_FNOX_AGE_KEY) organization secret.
  // Key the injection on the *called* reusable workflow, not the caller's filename: callers may have
  // arbitrary names (e.g. scheduled run-script callers), and GitHub rejects passing a secret that the
  // callee does not declare.
  // Only an @main callee is known to follow the current secret contract: a workflow pinned to an
  // older tag or SHA may still declare NPM_TOKEN (and not VERDACCIO_TOKEN), and GitHub rejects a
  // caller whose secrets do not match the selected revision's declarations, so pinned callers keep
  // their secrets untouched.
  const orgWorkflowCall = parseOrgReusableWorkflowCall(job.uses);
  const calledReusableWorkflow = orgWorkflowCall?.ref === 'main' ? orgWorkflowCall.workflowName : undefined;
  if (
    secrets &&
    kind === 'release' &&
    config.repoAuthor === 'WillBooster' &&
    calledReusableWorkflow === 'release' &&
    orgWorkflowCall?.extension === 'yml'
  ) {
    secrets.DISCORD_WEBHOOK_URL ??= '${{ secrets.DISCORD_WEBHOOK_URL_FOR_RELEASE }}';
  }
  const requiredPermissions = calledReusableWorkflow ? reusableWorkflowPermissions[calledReusableWorkflow] : undefined;
  if (requiredPermissions) job.permissions = { ...requiredPermissions };
  if (secrets) {
    setCalleeSecrets(config, secrets, calledReusableWorkflow);
  }
  if (kind === 'test-rust') {
    const [rustDirPath] = config.cargoTomlDirPaths;
    if (rustDirPath && rustDirPath !== '.') {
      job.with.working_directory = rustDirPath;
    } else {
      delete job.with.working_directory;
    }
  }

  // Reconstruct from the parsed call so a differently cased owner (GitHub is case-insensitive
  // there) is also normalized to the repository's own organization / mirror.
  const organization = ['WillBooster', 'WillBoosterLab'].find((name) =>
    config.repository?.startsWith(`github:${name}/`)
  );
  if (orgWorkflowCall && organization) {
    job.uses = `${organization}/reusable-workflows/.github/workflows/${orgWorkflowCall.workflowName}.${orgWorkflowCall.extension}@${orgWorkflowCall.ref}`;
  }

  if (config.doesContainDockerfile && !job.with.ci_label && kind.startsWith('test')) {
    job.with.ci_label = 'large';
  }
  normalizeRunnerInputs(config, job.with, job.uses, orgWorkflowCall?.workflowName);

  if (Object.keys(job.with).length > 0) {
    sortKeys(job.with);
  } else {
    delete job.with;
  }
  if (secrets) {
    // Delete-then-assign moves `secrets` to the end of the job's keys.
    delete job.secrets;
    if (Object.keys(secrets).length > 0) job.secrets = sortKeys(secrets);
  }
}

function setCalleeSecrets(
  config: PackageConfig,
  secrets: Record<string, unknown>,
  calledReusableWorkflow: string | undefined
): void {
  if (calledReusableWorkflow === 'test') {
    // The callee's "Test deploy script" step runs `wb deploy --dry-run`, which plans the Railway IaC.
    if (fs.existsSync(path.resolve(config.dirPath, '.railway', 'railway.ts'))) {
      secrets.RAILWAY_API_TOKEN = '${{ secrets.RAILWAY_API_TOKEN }}';
    } else {
      delete secrets.RAILWAY_API_TOKEN;
    }
  }
  if (!calledReusableWorkflow || !installCapableReusableWorkflows.has(calledReusableWorkflow)) return;

  // The callee routes public (default-registry) installs through the Takumi Guard
  // malicious-package-blocking proxy when this token resolves; an unset organization secret
  // expands to '' and the callee treats that as "feature off", so passing it is always safe.
  secrets.TAKUMI_GUARD_TOKEN = '${{ secrets.TAKUMI_GUARD_TOKEN }}';
  // The callee generates the workspace .npmrc for @willbooster-private/* from VERDACCIO_TOKEN
  // before installing dependencies. Only repositories that actually resolve private packages
  // (or publish to Verdaccio) get the pass-through: everywhere else the credential would flow
  // into CI runs that never use it, so the line is removed instead. The GitHub secret itself is
  // always registered manually and stays registered either way.
  if (repoResolvesPrivatePackages(config)) {
    secrets.VERDACCIO_TOKEN = '${{ secrets.VERDACCIO_TOKEN }}';
  } else {
    delete secrets.VERDACCIO_TOKEN;
  }
  if (fs.existsSync(path.resolve(config.dirPath, 'fnox.toml'))) {
    // Public repositories commit world-readable ciphertexts, so they decrypt with a dedicated
    // CI identity (the PUBLIC_FNOX_AGE_KEY organization secret) instead of the org-internal
    // one; the callee still receives it under its declared FNOX_AGE_KEY name. When no CI
    // identity resolves (see fnoxAgeKeyMapping), leave any existing mapping untouched and add
    // none: creating or rewriting one on incomplete information would map a possibly-public
    // repository to the wrong identity, and a fnox recipient sync failure does not stop this
    // generator from writing files — the failed run's rerun fills the mapping in.
    const mapping = fnoxAgeKeyMapping(config);
    if (mapping) {
      secrets.FNOX_AGE_KEY = mapping;
    }
  }
}

function normalizeRunnerInputs(
  config: PackageConfig,
  inputs: Record<string, unknown>,
  uses: string | undefined,
  calleeName: string | undefined
): void {
  if (!config.isRepoVisibilityKnown) return;
  const acceptsRunnerInput = ['test', 'test-rust', 'deploy', 'release', 'run-script'].includes(calleeName ?? '');
  if (config.isPublicRepo && acceptsRunnerInput) {
    inputs.github_hosted_runner = true;
  } else {
    delete inputs.github_hosted_runner;
  }
  if (config.isPublicRepo || inputs.runs_on === undefined) return;
  const labels = selfHostedRunnerInputSchema.safeParse(inputs.runs_on);
  if (labels.success) {
    inputs.runs_on = JSON.stringify(labels.data);
  } else {
    console.warn(`Removed runs_on from ${uses}: private repositories require a self-hosted label array.`);
    delete inputs.runs_on;
  }
}

/**
 * The secret expression the caller maps into the callee's declared FNOX_AGE_KEY, or undefined
 * when the repository state does not identify a usable CI identity — an unknown visibility, a
 * repository no CI scope covers (deriving from the same principal roster as the recipient sync
 * keeps the two from ever disagreeing), or a failed fnox recipient sync, whose ciphertexts may
 * still target the previous identity. The caller must then preserve any existing mapping.
 */
function fnoxAgeKeyMapping(config: PackageConfig): string | undefined {
  if (!config.isRepoVisibilityKnown || hasFnoxSyncFailed()) return undefined;
  const secretName = resolveFnoxCiAgeKeySecretName(config);
  return secretName && `\${{ secrets.${secretName} }}`;
}

async function writeYaml(newSettings: Workflow, filePath: string): Promise<void> {
  // A permissions object emptied by the per-kind deletions (e.g. an existing test-rust caller
  // whose only entry was `actions`) must be dropped entirely: `permissions: {}` strips EVERY
  // token permission from the workflow, unlike the absent key which keeps the defaults.
  if (newSettings.permissions && Object.keys(newSettings.permissions).length === 0) {
    delete newSettings.permissions;
  }
  await fsUtil.writeFileConfined(filePath, dumpYamlOver(await fsUtil.readFileIfExists(filePath), newSettings));
}
