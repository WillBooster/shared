// GitHub Actions valueless events such as `pull_request:` require YAML null values.
// oxlint-disable eslint-plugin-import/no-named-as-default-member -- Namespace YAML calls make load/dump usage clearer.
/* eslint-disable unicorn/no-null */

import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import yaml from 'js-yaml';

import { logger } from '../logger.js';
import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';
import type { PackageConfig } from '../packageConfig.js';
import { combineMerge } from '../utils/mergeUtil.js';
import { moveToBottom, sortKeys } from '../utils/objectUtil.js';
import { promisePool } from '../utils/promisePool.js';

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

const publicRepoAutofixWorkflow: Workflow = {
  name: 'autofix.ci',
  on: {
    pull_request: null,
    push: {
      branches: ['main'],
    },
  },
  permissions: {
    contents: 'read',
  },
  concurrency: {
    group: 'autofix-${{ github.head_ref }}',
    'cancel-in-progress': true,
  },
  jobs: {
    autofix: { 'runs-on': 'ubuntu-latest' },
  },
};

const workflows = {
  test: {
    name: 'Test',
    on: {
      pull_request: null,
      push: {
        branches: ['main', 'wbfy'],
      },
    },
    // cf. https://docs.github.com/en/actions/using-jobs/using-concurrency#example-only-cancel-in-progress-jobs-or-runs-for-the-current-workflow
    concurrency: {
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    },
    permissions: {
      // for linter fix
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
        branches: ['main', 'wbfy'],
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
  'close-comment': {
    name: 'Add close comment',
    on: {
      pull_request: {
        types: ['opened'],
      },
    },
    jobs: {
      'close-comment': {
        uses: 'WillBooster/reusable-workflows/.github/workflows/close-comment.yml@main',
      },
    },
  },
} as const;

type KnownKind = keyof typeof workflows | 'deploy' | 'autofix';

/**
 * Parses a `uses:` value calling one of WillBooster's own reusable workflows (or the
 * WillBoosterLab sync mirror) into the workflow name (without extension) and git ref. Only those
 * follow the contract wbfy enforces — callers of another organization's same-named repository are
 * left alone. GitHub treats owner/repository names case-insensitively, so the comparison does
 * too, while the workflow path and ref stay case-sensitive.
 */
function parseOrgReusableWorkflowCall(
  uses: string | undefined
): { workflowName: string; extension: string; ref: string } | undefined {
  const match = /^([^/]+)\/([^/]+)\/\.github\/workflows\/([^/@]+?)\.(ya?ml)@(.+)$/u.exec(uses ?? '');
  if (!match) return undefined;
  const owner = match[1]!.toLowerCase();
  if ((owner !== 'willbooster' && owner !== 'willboosterlab') || match[2]!.toLowerCase() !== 'reusable-workflows') {
    return undefined;
  }
  return { workflowName: match[3]!, extension: match[4]!, ref: match[5]! };
}

export async function generateWorkflows(rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateWorkflow', async () => {
    if (isReusableWorkflowsRepo(rootConfig.repository)) {
      // Don't touch reusable-workflows repo because it hosts upstream workflow definitions.
      return;
    }

    const workflowsPath = path.resolve(rootConfig.dirPath, '.github', 'workflows');
    // With .github or .github/workflows symlinked outside the repository, writeYaml's guards
    // already refuse the writes, but readdir/rm below would still enumerate and DELETE files
    // outside the repository — so require the directory to resolve inside it before any
    // traversal, mkdir, or cleanup.
    if (!(await fsUtil.isConfinedWritablePath(workflowsPath))) {
      console.warn(`Skipped generating workflows because ${workflowsPath} resolves outside the repository.`);
      return;
    }
    await fs.promises.mkdir(workflowsPath, { recursive: true });

    // Remove config of semantic pull request
    const semanticYmlPath = path.resolve(rootConfig.dirPath, '.github', 'semantic.yml');
    await promisePool.run(() => fsUtil.removeConfined(semanticYmlPath, { recursive: true }));

    const entries = await fs.promises.readdir(workflowsPath, { withFileTypes: true });
    // Decide obsolescence once (the content check reads each file) and AWAIT the deletions:
    // promisePool.run resolves when a task enters the pool, not when it completes, so a pooled
    // deletion could race the regeneration below on the same path (e.g. a `test.yml` whose only
    // job called the retired gen-pr workflow would be merged with its stale on-disk content).
    const obsoleteGenPrFileNames = new Set(
      entries
        .filter((entry) => entry.isFile() && isObsoleteGenPrWorkflow(workflowsPath, entry.name))
        .map((entry) => entry.name)
    );
    for (const fileName of obsoleteGenPrFileNames) {
      await fsUtil.removeConfined(path.join(workflowsPath, fileName));
    }
    // GitHub accepts both .yml and .yaml workflow files, and a workflow's file name is its public
    // identity (badge URLs, the workflow REST API, same-repository `uses:` references), so .yaml
    // files are processed under their own name instead of being renamed or silently left stale.
    // Each kind maps to the one file that carries it; when both spellings exist the .yml wins and
    // the .yaml twin is left untouched, since merging two workflow definitions is ambiguous.
    const fileNamesByKind = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name) || obsoleteGenPrFileNames.has(entry.name)) continue;
      const kind = entry.name.replace(/\.ya?ml$/u, '');
      const existingFileName = fileNamesByKind.get(kind);
      if (existingFileName === undefined || existingFileName.endsWith('.yaml')) {
        fileNamesByKind.set(kind, entry.name);
      }
    }
    const mandatoryKinds = ['test', 'autofix', 'semantic-pr', 'close-comment'];
    if (rootConfig.depending.semanticRelease) {
      mandatoryKinds.push('release');
    }
    if (rootConfig.cargoTomlDirPaths.length > 0) {
      mandatoryKinds.push('test-rust');
    }
    for (const kind of mandatoryKinds) {
      if (!fileNamesByKind.has(kind)) {
        fileNamesByKind.set(kind, `${kind}.yml`);
      }
    }
    // A Cloudflare repository with a wb-driven deploy script but no deploy workflow gets a
    // dispatch-only production caller scaffolded, so new repositories need no hand-written
    // deploy wiring (maintainers add push/release triggers themselves once ready). The gate is
    // the wrangler config at the deploy script's worker directory, NOT isCloudflare — that
    // heuristic also reads workflow files, which are exactly what is missing here.
    // "Already has a deploy workflow" is judged by CONTENT as well as filename: a caller of the
    // reusable deploy workflow may live under any filename (e.g. cloudflare.yml), and a
    // deploy-prefixed file that never calls it (e.g. deploy-docs.yml) still suppresses the
    // scaffold only via the conservative filename check.
    if (resolveCloudflareDeployTarget(rootConfig) && !hasCloudflareDeployWorkflow(workflowsPath)) {
      fileNamesByKind.set('deploy', 'deploy.yml');
    }
    if (fileNamesByKind.has('sync')) {
      // The sync workflow's generation owns these files (it rewrites the force-sync workflow and
      // deletes the obsolete sync-init one), so processing them as independent kinds would race
      // concurrent writes on the same paths.
      fileNamesByKind.delete('sync-force');
      fileNamesByKind.delete('sync-init');
    }
    if (!rootConfig.isPublicRepo) {
      // The reusable test workflow already fixes and pushes code on private repos,
      // so a separate autofix workflow only duplicates the same process.
      fileNamesByKind.delete('autofix');
      for (const autofixFileName of ['autofix.yml', 'autofix.yaml']) {
        await promisePool.run(() => fsUtil.removeConfined(path.join(workflowsPath, autofixFileName)));
      }
    }

    for (const [kind, fileName] of fileNamesByKind) {
      // 実際はKnownKind以外の値も代入されることに注意
      await promisePool.run(() => writeWorkflowYaml(rootConfig, workflowsPath, kind as KnownKind, fileName));
    }
  });
}

export function isReusableWorkflowsRepo(repository?: string): boolean {
  return repository?.endsWith('/reusable-workflows') ?? false;
}

/**
 * The gen-pr workflow family is retired (the reusable gen-pr.yml no longer exists), so wbfy
 * removes its callers: any `gen-pr*.yml` file, plus a file under another name whose jobs ALL call
 * the reusable gen-pr workflow. Mixed files keep their other jobs, and unparsable files are only
 * matched by filename — deleting a whole workflow on a text match would be too aggressive.
 */
export function isObsoleteGenPrWorkflow(workflowsPath: string, fileName: string): boolean {
  if (/^gen-pr(?:-.+)?\.ya?ml$/u.test(fileName)) return true;
  if (!/\.ya?ml$/u.test(fileName)) return false;
  let content: string;
  try {
    content = fs.readFileSync(path.join(workflowsPath, fileName), 'utf8');
  } catch {
    return false;
  }
  // Owner-restricted: only WillBooster's own reusable gen-pr workflow was retired, so a caller of
  // some other organization's same-named workflow must not be deleted.
  const isGenPrCall = (uses: unknown): boolean =>
    typeof uses === 'string' && parseOrgReusableWorkflowCall(uses)?.workflowName === 'gen-pr';
  try {
    const workflow = yaml.load(content) as Workflow | undefined;
    if (workflow && typeof workflow === 'object' && workflow.jobs && typeof workflow.jobs === 'object') {
      const jobs = Object.values(workflow.jobs);
      return jobs.length > 0 && jobs.every((job) => isGenPrCall(job?.uses));
    }
  } catch {
    // Fall through to the filename-only decision above.
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
  const deployProductionFileName = ['deploy-production.yml', 'deploy-production.yaml'].find((deployFileName) =>
    fs.existsSync(path.join(workflowsPath, deployFileName))
  );

  if (kind === 'autofix') {
    await writeYaml(generateAutofixWorkflow(config), filePath);
    return;
  }

  // A test-rust.yml in a repo without Rust code is a custom workflow that merely shares the name; leave it alone.
  if (kind === 'test-rust' && config.cargoTomlDirPaths.length === 0) return;

  let newSettings = structuredClone(kind in workflows ? workflows[kind as keyof typeof workflows] : {}) as Workflow;
  if (kind === 'deploy' && !fs.existsSync(filePath)) {
    const scaffold = generateCloudflareDeployWorkflow(config);
    if (!scaffold) return;
    newSettings = scaffold;
  }

  const oldContent = await fsUtil.readFileIfExists(filePath);
  if (oldContent !== undefined) {
    let oldSettings: Workflow;
    try {
      oldSettings = yaml.load(oldContent) as Workflow;
    } catch {
      // An existing workflow wbfy cannot parse must be left untouched: writing the template
      // without merging would silently discard the repository's workflow.
      console.warn(`Skipped generating ${filePath} because the existing content is not parsable as YAML.`);
      return;
    }
    // yaml.load returns undefined for empty/comment-only files and non-objects for scalar
    // documents without throwing; deepmerge would crash on them.
    if (typeof oldSettings !== 'object' || oldSettings === null || Array.isArray(oldSettings)) {
      console.warn(`Skipped generating ${filePath} because the existing content is not a workflow.`);
      return;
    }
    newSettings = merge.all([newSettings, oldSettings, newSettings], { arrayMerge: combineMerge }) as Workflow;
  }

  // Skip a broken workflow
  if (!('jobs' in newSettings)) return;

  if (kind === 'test-rust') {
    // Migrate hand-written Rust workflows (e.g. an inline cargo-check job) to the reusable workflow.
    for (const [jobName, job] of Object.entries(newSettings.jobs)) {
      // A job written as `jobName:` with no body parses as null.
      if (!job?.uses?.includes('/reusable-workflows/')) {
        delete newSettings.jobs[jobName];
      }
    }
    moveToBottom(newSettings, 'jobs');
  }

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
    // Move jobs to the bottom
    moveToBottom(newSettings, 'jobs');
    if (newSettings.on?.push) {
      newSettings.on.push['paths-ignore'] = [
        ...new Set(['**.md', '**/docs/**', ...(newSettings.on.push['paths-ignore'] ?? [])]),
      ];
    }
  }

  if (kind === 'release' && newSettings.jobs.release && deployProductionFileName) {
    newSettings.permissions ??= {};
    newSettings.permissions.actions = 'write';
    newSettings.jobs.release.with ??= {};
    newSettings.jobs.release.with.trigger_deploy_workflow = deployProductionFileName;
  }

  let isReusableWorkflow = false;
  for (const job of Object.values(newSettings.jobs)) {
    // Ignore empty jobs (a bare `jobName:` parses as null), non-reusable workflows, and other
    // organizations' reusable workflows: a same-named `reusable-workflows` repository elsewhere
    // follows a different contract, and normalizing its callers (secret injection/removal,
    // permissions) could break them.
    if (!job || !parseOrgReusableWorkflowCall(job.uses)) continue;

    normalizeJob(config, job, kind);
    isReusableWorkflow = true;
  }
  if (!isReusableWorkflow) return;

  // Deploy callers need no repository writes: the called reusable workflow inherits the caller's
  // token permissions, repositories default the token to write, and the reusable deploy workflow
  // at main performs no GITHUB_TOKEN writes. The read-only default is injected at the JOB level
  // (job permissions do not affect sibling jobs, so inline jobs or pinned callees — whose write
  // needs are unaudited — keep theirs), and only when neither the workflow nor the job declares
  // its own permissions (OIDC deploys always do, for id-token). run-script callers are excluded
  // because arbitrary package scripts may push commits.
  if (!newSettings.permissions) {
    for (const job of Object.values(newSettings.jobs)) {
      if (!job) continue;
      const call = parseOrgReusableWorkflowCall(job.uses);
      if (!job.permissions && call?.workflowName === 'deploy' && call.ref === 'main') {
        job.permissions = { contents: 'read' };
      }
    }
  }

  switch (kind) {
    case 'release': {
      if (newSettings.on?.schedule) {
        delete newSettings.on.push;
      } else if (newSettings.on?.push && config.release.branches.length > 0) {
        newSettings.on.push.branches = config.release.branches;
      } else {
        // Don't use the release workflow if release branch is not specified
        await fsUtil.removeConfined(filePath);
        return;
      }
      if (config.isPublicRepo) {
        newSettings.permissions ??= {};
        newSettings.permissions['id-token'] = 'write';
      } else {
        delete newSettings.permissions?.['id-token'];
      }
      break;
    }
    case 'test':
    case 'test-rust': {
      // Don't use `paths-ignore` for test because GitHub's Branch Protection and Rulesets require job running.
      // The reusable test workflow no longer needs Actions write access.
      delete newSettings.permissions?.actions;
      if (newSettings.on?.pull_request) {
        delete newSettings.on.pull_request['paths-ignore'];
      }
      if (newSettings.on?.push) {
        delete newSettings.on.push['paths-ignore'];
        newSettings.on.push.branches = newSettings.on.push.branches.filter((branch) => branch !== 'renovate/**');
      }
      break;
    }
    // No default
  }
  await writeYaml(newSettings, filePath);

  if (kind === 'sync') {
    for (const syncInitFileName of ['sync-init.yml', 'sync-init.yaml']) {
      await fsUtil.removeConfined(path.join(workflowsPath, syncInitFileName));
    }
    if (!newSettings.jobs.sync?.with) return;

    // Generate the force-sync workflow based on the sync workflow if it exists, keeping the
    // spelling of an existing sync-force file so its identity (badge URLs, API) is preserved.
    newSettings.jobs['sync-force'] = newSettings.jobs.sync;
    const params = newSettings.jobs.sync.with.sync_params_without_dest;
    if (typeof params !== 'string') return;

    newSettings.jobs.sync.with.sync_params_without_dest = `--force ${params}`;
    newSettings.name = 'Force to Sync';
    newSettings.on = { workflow_dispatch: null };
    delete newSettings.jobs.sync;
    const syncForceFileName =
      !fs.existsSync(path.join(workflowsPath, 'sync-force.yml')) &&
      fs.existsSync(path.join(workflowsPath, 'sync-force.yaml'))
        ? 'sync-force.yaml'
        : 'sync-force.yml';
    await writeYaml(newSettings, path.join(workflowsPath, syncForceFileName));
  }
}

/**
 * Scaffolds a dispatch-only production deploy caller for a Cloudflare repository. The worker
 * directory is read from the root deploy script (`wb deploy -w packages/<worker>`; the repo root
 * otherwise) and `server_url` from the production custom-domain route in wrangler.jsonc when one
 * exists. The shared normalization then injects concurrency, job-level read-only permissions,
 * and the FNOX_AGE_KEY/VERDACCIO_TOKEN secrets like any hand-written caller.
 */
export function generateCloudflareDeployWorkflow(rootConfig: PackageConfig): Workflow | undefined {
  const workerDirPath = resolveCloudflareDeployTarget(rootConfig);
  if (!workerDirPath) return;
  const serverUrl = readProductionCustomDomain(rootConfig.dirPath, workerDirPath);
  return {
    name: 'Deploy',
    on: { workflow_dispatch: null },
    jobs: {
      deploy: {
        uses: 'WillBooster/reusable-workflows/.github/workflows/deploy.yml@main',
        with: {
          environment: 'production',
          file_path_1: path.posix.join(workerDirPath, '.env.cloudflare'),
          ...(serverUrl ? { server_url: serverUrl } : {}),
        },
        secrets: {
          DISCORD_WEBHOOK_URL: '${{ secrets.DISCORD_WEBHOOK_URL_FOR_RELEASE }}',
          FILE_CONTENT_1: 'CLOUDFLARE_API_TOKEN=${{ secrets.CLOUDFLARE_API_TOKEN }}',
        },
      },
    },
  };
}

// wb's global options that consume a following value token (from sharedOptionsBuilder plus
// yargsOptionsBuilderForEnv); every other `-`-prefixed token before the subcommand is a boolean.
const wbGlobalValueOptions = new Set(['--working-dir', '-w', '--env', '--cascade-env', '--check-env']);

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
  '--dir',
  '-p',
  '--package',
  '-c',
  '--call',
]);

// Runner options that change the process working directory, so `wb`'s own `-w` (and every wrangler
// path) resolves relative to a directory this static parser cannot recover. Their presence makes
// the worker-directory resolution unsound, so scaffolding is declined rather than guessed.
const cwdChangingRunnerOptions = new Set(['--cwd', '-C', '--prefix', '--dir']);

/**
 * Advance past a runner's `-`-prefixed options, consuming a separate value token where one applies.
 * `sawCwdChange` reports whether any option relocates the working directory (see
 * cwdChangingRunnerOptions), so the caller can decline scaffolding it cannot resolve correctly.
 */
function skipRunnerOptions(tokens: string[], startIndex: number): { index: number; sawCwdChange: boolean } {
  let index = startIndex;
  let sawCwdChange = false;
  while (index < tokens.length && (tokens[index] ?? '').startsWith('-')) {
    const option = tokens[index] ?? '';
    const bareOption = option.includes('=') ? option.slice(0, option.indexOf('=')) : option;
    if (cwdChangingRunnerOptions.has(bareOption)) sawCwdChange = true;
    index++;
    if (!option.includes('=') && runnerValueOptions.has(option) && index < tokens.length) index++;
  }
  return { index, sawCwdChange };
}

/**
 * Tokenize a shell command line into command segments, each a list of tokens with quotes removed.
 * A new segment starts at an unquoted `&&`/`||`/`;`/`|`/`&`; an unquoted `#` starts a comment to
 * end of line; a backslash escapes the next character (so `\;` is a literal, not a separator);
 * grouping parentheses `(`/`)` are token separators, so `(wb deploy)` tokenizes as `wb deploy`.
 * Segments/tokens model command structure precisely enough that quoted operators, escaped
 * operators, comments, and subshell groups neither fabricate nor hide a `wb deploy` invocation.
 */
function tokenizeShellCommand(script: string): { segments: string[][]; sawHeredoc: boolean } {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: string | undefined;
  // Whether the script uses any heredoc. Faithfully classifying which body lines are data (the
  // delimiter word can be quoted/backslash-escaped, `<<-` strips leading tabs, terminators match
  // exactly) is more than this parser models, so a heredoc anywhere makes the caller decline
  // scaffolding instead of risking either reading a body line as a command or hiding a real one.
  let sawHeredoc = false;
  // Heredoc delimiters whose bodies begin at the NEXT newline: `cat <<A <<B` queues A then B, and
  // the commands AFTER the `<<` header on the same line still execute, so the header is recorded
  // here and the bodies are skipped only when the line's newline is reached.
  let pendingHeredocDelimiters: string[] = [];
  const skipHeredocBodies = (fromIndex: number): number => {
    let cursor = fromIndex;
    for (const delimiter of pendingHeredocDelimiters) {
      while (cursor < script.length) {
        const lineStart = cursor + 1;
        let lineEnd = lineStart;
        while (lineEnd < script.length && script[lineEnd] !== '\n') lineEnd++;
        cursor = lineEnd;
        if (script.slice(lineStart, lineEnd).trim() === delimiter) break;
        if (lineEnd >= script.length) break;
      }
    }
    pendingHeredocDelimiters = [];
    return cursor;
  };
  const endToken = (): void => {
    if (inToken) tokens.push(current);
    current = '';
    inToken = false;
  };
  const endSegment = (): void => {
    endToken();
    segments.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < script.length; index++) {
    const character = script[index] ?? '';
    if (quote) {
      if (character === '\\' && quote === '"') {
        // Inside double quotes, backslash-newline is still a line continuation (both removed);
        // any other escaped character contributes literally.
        if (script[index + 1] === '\n') index++;
        else current += script[++index] ?? '';
        continue;
      }
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '\\') {
      // Backslash-newline is a line continuation: the shell removes both, joining the lines
      // without introducing a token boundary. Any other escaped character is a literal.
      if (script[index + 1] === '\n') {
        index++;
        continue;
      }
      current += script[++index] ?? '';
      inToken = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      inToken = true;
      continue;
    }
    // A `<<`/`<<-` heredoc redirection: its body lines (up to the delimiter line) are DATA, not
    // commands, so `cat <<'EOF'\nwb deploy\nEOF` must not read `wb deploy` as an invocation.
    if (character === '<' && script[index + 1] === '<') {
      let cursor = index + 2;
      if (script[cursor] === '-') cursor++;
      while (/[ \t]/u.test(script[cursor] ?? '')) cursor++;
      let delimiter = '';
      // The delimiter word may be quoted (`<<'EOF'`) or backslash-escaped (`<<\EOF`); either form
      // just disables body expansion, so collect the bare word. Missing the escaped form would drop
      // `sawHeredoc` and read the heredoc body as commands.
      let delimiterQuote: string | undefined;
      while (cursor < script.length) {
        const delimiterChar = script[cursor] ?? '';
        if (delimiterQuote) {
          if (delimiterChar === delimiterQuote) delimiterQuote = undefined;
          else delimiter += delimiterChar;
        } else if (delimiterChar === '\\') {
          // A backslash quotes the next character into the delimiter word (`<<\EOF` → `EOF`).
          cursor++;
          delimiter += script[cursor] ?? '';
        } else if (delimiterChar === "'" || delimiterChar === '"') {
          delimiterQuote = delimiterChar;
        } else if (/[\w.-]/u.test(delimiterChar)) {
          delimiter += delimiterChar;
        } else {
          break;
        }
        cursor++;
      }
      if (delimiter) {
        // The `<<delim` header is a redirection (not a token); record the delimiter and keep
        // parsing the rest of this line — its body is skipped when the newline is reached.
        sawHeredoc = true;
        endToken();
        pendingHeredocDelimiters.push(delimiter);
        index = cursor - 1;
        continue;
      }
    }
    if (character === '#' && !inToken) {
      // Comment runs to end of line; end the current command segment and let the loop resume at
      // the newline so the next line is parsed as its own segment.
      endSegment();
      while (index + 1 < script.length && script[index + 1] !== '\n') index++;
      continue;
    }
    if (character === '&' || character === '|' || character === ';' || character === '\n') {
      endSegment();
      if ((character === '&' || character === '|') && script[index + 1] === character) index++;
      // A newline that closes a heredoc header line consumes the queued bodies before the next
      // command.
      if (character === '\n' && pendingHeredocDelimiters.length > 0) index = skipHeredocBodies(index);
      continue;
    }
    if (character === '(' || character === ')') {
      endToken();
      continue;
    }
    if (/\s/u.test(character)) {
      endToken();
      continue;
    }
    current += character;
    inToken = true;
  }
  endSegment();
  return { segments, sawHeredoc };
}

/**
 * The wb argument tokens of a `wb … deploy` invocation (everything after `wb`, so BOTH the global
 * options that precede `deploy` and the arguments that follow it), or undefined when no segment
 * runs `wb deploy` at command position. Env assignments, package runners, and global yargs options
 * (with their value tokens) may precede the deploy command; shell quoting/escaping/comments/
 * grouping are honored. Returning both sides lets the worker-directory resolver read `-w` wherever
 * it appears, since wb declares it globally.
 */
function parseWbDeployArgs(deployScript: string): string[] | undefined {
  const { segments, sawHeredoc } = tokenizeShellCommand(deployScript);
  // A heredoc makes body-vs-command classification unreliable (see tokenizeShellCommand); decline.
  if (sawHeredoc) return undefined;
  for (const tokens of segments) {
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? '')) index++;
    // Leading launchers run the following command: `env` (with options + KEY=value assignments)
    // and the POSIX `command` builtin (with its `-p`/`-v`/`-V` options). Command-position shell
    // reserved words and other launchers (`if`/`then`/`for`/`time`/`exec`/`!`/brace groups, …) are
    // NOT modeled: they leave a non-`wb` first token, so the segment simply does not match and
    // scaffolding is declined — a deliberate false-negative (safe for guidance) over guessing.
    if (tokens[index] === 'env') {
      index++;
      while (index < tokens.length) {
        const token = tokens[index] ?? '';
        if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) index++;
        // env's `-C`/`--chdir` relocates the working directory, so `wb`'s `-w` and wrangler paths
        // resolve from a directory this parser cannot recover: decline rather than mis-resolve.
        else if (token === '-C' || token === '--chdir') return undefined;
        else if (token === '-u') index += 2;
        else if (token.startsWith('-')) index++;
        else break;
      }
    }
    // `command CMD` executes CMD, but `command -v`/`-V CMD` only QUERY its availability without
    // running it, so a deploy behind them does not run.
    while (tokens[index] === 'command') {
      index++;
      let queriesOnly = false;
      while (index < tokens.length && (tokens[index] ?? '').startsWith('-')) {
        if (tokens[index] === '-v' || tokens[index] === '-V') queriesOnly = true;
        index++;
      }
      if (queriesOnly) {
        index = -1;
        break;
      }
    }
    if (index < 0) continue;
    // Resolve a runner prefix to whether the following token is a BINARY (the wb executable) or a
    // package SCRIPT name. `bunx`/`npx` and `<pm> x|dlx|exec` run a binary; `<pm> run|run-script`
    // (and bare `npm <name>`, or any runner followed by `--`) run a package script — so
    // `npm run wb deploy` executes the script named `wb`, not the wb binary, and must be rejected.
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(tokens[index] ?? '')) {
      const runner = tokens[index] ?? '';
      const runnerScan = skipRunnerOptions(tokens, index + 1);
      // A cwd-changing runner option (`--cwd`/`-C`/`--prefix`/`--dir`) moves where `wb -w` resolves,
      // which this parser cannot recover, so decline rather than scaffold a wrong target.
      if (runnerScan.sawCwdChange) return undefined;
      index = runnerScan.index;
      const subcommand = tokens[index] ?? '';
      if (['run', 'run-script'].includes(subcommand)) continue; // runs a package script, not wb
      if (['x', 'dlx', 'exec'].includes(subcommand))
        index++; // binary runner (pnpm dlx, bun x, …)
      else if (runner === 'npm') continue; // bare `npm wb` never runs a binary
    } else if (['bunx', 'npx'].includes(tokens[index] ?? '')) {
      const runnerScan = skipRunnerOptions(tokens, index + 1);
      if (runnerScan.sawCwdChange) return undefined;
      index = runnerScan.index;
    }
    if (tokens[index] !== 'wb') continue;
    const wbArgs = tokens.slice(index + 1);
    // Skip global options (and any value token a value-bearing option consumes) so the FIRST
    // command token decides: `wb --cascade-env production deploy` and `wb -w packages/api deploy`
    // match, while subcommands owning their own `deploy` (`wb prisma deploy`, `wb retry deploy`)
    // do not. `--opt=value` carries its value inline, so only the space-separated form skips one.
    let commandIndex = 0;
    while (commandIndex < wbArgs.length && (wbArgs[commandIndex] ?? '').startsWith('-')) {
      const flag = wbArgs[commandIndex] ?? '';
      commandIndex++;
      if (wbGlobalValueOptions.has(flag) && commandIndex < wbArgs.length) commandIndex++;
    }
    if (wbArgs[commandIndex] !== 'deploy') continue;
    return wbArgs;
  }
  return undefined;
}

/** Whether a deploy script invokes `wb … deploy` at command position. */
export function invokesWbDeploy(deployScript: string): boolean {
  return parseWbDeployArgs(deployScript) !== undefined;
}

/** The `-w`/`--working-dir` value among the wb invocation's tokens (either side of `deploy`), or `.`. */
function workerDirPathFromDeployArgs(deployArgs: string[]): string {
  for (let index = 0; index < deployArgs.length; index++) {
    const token = deployArgs[index] ?? '';
    if (token === '-w' || token === '--working-dir') return deployArgs[index + 1] ?? '.';
    // yargs also accepts `--working-dir=path`, `-w=path`, and the attached short form `-wpath`.
    const inlineMatch = /^(?:--working-dir=|-w=?)(.+)$/u.exec(token);
    if (inlineMatch) return inlineMatch[1] ?? '.';
  }
  return '.';
}

/**
 * Whether the workflows directory holds a live caller of the reusable Cloudflare deploy workflow.
 * YAML is parsed and only `jobs.*.uses` values are inspected (a raw-text search would match
 * comments or `run:` strings), with a `deploy*`-filename shortcut and a conservative raw-text
 * fallback for unparseable files. Shared by the workflow scaffolder and the agent-instruction
 * generator so both judge "already has a deploy workflow" identically.
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
  const callsDeployWorkflow = (uses: string | undefined): boolean =>
    parseOrgReusableWorkflowCall(uses)?.workflowName === 'deploy';
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
        return Object.values(workflow.jobs).some((job) => callsDeployWorkflow(job?.uses));
      }
      return false;
    } catch {
      return deployCallPattern.test(content);
    }
  });
}

/** The worker directory of a wb-driven Cloudflare deploy script, or undefined when there is none. */
function resolveCloudflareDeployTarget(rootConfig: Pick<PackageConfig, 'dirPath' | 'packageJson'>): string | undefined {
  const deployScript = rootConfig.packageJson?.scripts?.deploy;
  if (typeof deployScript !== 'string') return;
  // Compound scripts (`bun run build && wb deploy -w …`) may carry unrelated options in other
  // segments, so isolate the shell segment that actually INVOKES wb (as a command token — not a
  // word inside `echo wb deploy` or an env value) and read the working directory from ITS parsed
  // argument tokens, never a raw-text regex (which could match `-w` inside an env value).
  const deployArgs = parseWbDeployArgs(deployScript);
  if (!deployArgs) return;
  // Normalize spellings such as `./packages/api` and `packages/api/` before the layout check.
  const workerDirPath = path.posix.normalize(workerDirPathFromDeployArgs(deployArgs)).replace(/\/+$/u, '') || '.';
  // Restrict scaffolding to the layouts wbfy's secret verification also understands (the repo
  // root and direct packages/*, apps/* workspaces) so a generated workflow never references a
  // CLOUDFLARE_API_TOKEN that `wbfy --env` would not verify.
  if (!/^(?:\.|(?:packages|apps)\/[^/]+)$/u.test(workerDirPath)) return;
  // wb deploy supports wrangler.jsonc/wrangler.json only (no TOML), so a TOML-only target would
  // scaffold a workflow that always fails.
  const hasWranglerConfig = ['wrangler.jsonc', 'wrangler.json'].some((fileName) =>
    fs.existsSync(path.resolve(rootConfig.dirPath, workerDirPath, fileName))
  );
  return hasWranglerConfig ? workerDirPath : undefined;
}

function readProductionCustomDomain(rootDirPath: string, workerDirPath: string): string | undefined {
  // Parse ONLY the config wb deploy selects (wrangler.jsonc wins over wrangler.json): a stale
  // sibling config must not contribute a server_url the deploy never serves.
  const configPath = ['wrangler.jsonc', 'wrangler.json']
    .map((fileName) => path.resolve(rootDirPath, workerDirPath, fileName))
    .find((candidatePath) => fs.existsSync(candidatePath));
  if (!configPath) return undefined;
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return undefined;
  }
  const wranglerConfig = jsoncUtil.parseObjectIgnoringError<{
    env?: { production?: { route?: unknown; routes?: unknown } };
    route?: unknown;
    routes?: unknown;
  }>(content);
  if (!wranglerConfig) return undefined;
  // Routes are non-inheritable in wrangler: when an env.production section exists it is
  // authoritative (no fallback to top-level), mirroring wb deploy's resolution. Both the
  // plural `routes` and the singular `route` spellings are accepted.
  const production = wranglerConfig.env?.production;
  const rawRoutes = production
    ? (production.routes ?? production.route)
    : (wranglerConfig.routes ?? wranglerConfig.route);
  const routes = Array.isArray(rawRoutes) ? rawRoutes : rawRoutes ? [rawRoutes] : [];
  for (const route of routes) {
    if (
      route &&
      typeof route === 'object' &&
      (route as { custom_domain?: unknown }).custom_domain === true &&
      typeof (route as { pattern?: unknown }).pattern === 'string'
    ) {
      return `https://${(route as { pattern: string }).pattern}/`;
    }
  }
  return undefined;
}

// The reusable workflows that declare FNOX_AGE_KEY and VERDACCIO_TOKEN under
// on.workflow_call.secrets (see WillBooster/reusable-workflows). Passing either secret to any
// other callee is a GitHub error.
const installCapableReusableWorkflows = new Set(['autofix', 'deploy', 'release', 'run-script', 'test']);

function normalizeJob(config: PackageConfig, job: Job, kind: KnownKind): void {
  job.with ??= {};
  // `secrets: inherit` (parsed by js-yaml as a plain string) already forwards every caller secret
  // including the ones injected below, so preserve it untouched — property assignments on the
  // string would throw.
  const secrets = job.secrets === 'inherit' ? undefined : (job.secrets = job.secrets ?? {});

  if (secrets && (kind === 'test' || kind === 'release')) {
    secrets.GH_TOKEN = '${{ secrets.GITHUB_TOKEN }}';
  }

  // fnox.toml carries age-encrypted app secrets; CI decrypts them with the FNOX_AGE_KEY repository secret.
  // Key the injection on the *called* reusable workflow, not the caller's filename: callers may have
  // arbitrary names (e.g. scheduled run-script callers), and GitHub rejects passing a secret that the
  // callee does not declare. The legacy DOT_ENV pass-through is deliberately kept: FNOX_AGE_KEY
  // provisioning can be skipped (no --env, missing token or age identity), and the pass-through keeps
  // CI working from the still-existing DOT_ENV secret until the fnox migration completes.
  // Only an @main callee is known to follow the current secret contract: a workflow pinned to an
  // older tag or SHA may still declare NPM_TOKEN (and not VERDACCIO_TOKEN), and GitHub rejects a
  // caller whose secrets do not match the selected revision's declarations, so pinned callers keep
  // their secrets untouched.
  const orgWorkflowCall = parseOrgReusableWorkflowCall(job.uses);
  const calledReusableWorkflow = orgWorkflowCall?.ref === 'main' ? orgWorkflowCall.workflowName : undefined;
  if (secrets && calledReusableWorkflow && installCapableReusableWorkflows.has(calledReusableWorkflow)) {
    // The callee generates the workspace .npmrc for @willbooster-private/* from VERDACCIO_TOKEN
    // before installing dependencies, which every repository needs regardless of its fnox
    // migration state.
    secrets.VERDACCIO_TOKEN = '${{ secrets.VERDACCIO_TOKEN }}';
    if (fs.existsSync(path.resolve(config.dirPath, 'fnox.toml'))) {
      secrets.FNOX_AGE_KEY = '${{ secrets.FNOX_AGE_KEY }}';
    }
  }
  // reusable-workflows replaced the NPM_TOKEN secret declaration with VERDACCIO_TOKEN; GitHub
  // rejects passing an undeclared secret to a reusable workflow with a startup_failure that emits
  // no check runs, so a leftover NPM_TOKEN silently disables every calling workflow.
  if (secrets && calledReusableWorkflow) {
    delete secrets.NPM_TOKEN;
  }

  if (secrets?.FIREBASE_TOKEN) {
    secrets.GCP_SA_KEY_JSON_FOR_FIREBASE = '${{ secrets.GCP_SA_KEY_JSON_FOR_FIREBASE }}';
    delete secrets.FIREBASE_TOKEN;
  }
  if (
    secrets &&
    ((secrets.DISCORD_WEBHOOK_URL && (kind === 'release' || kind.startsWith('deploy'))) ||
      (job.with.server_url && kind.startsWith('deploy')))
  ) {
    secrets.DISCORD_WEBHOOK_URL = '${{ secrets.DISCORD_WEBHOOK_URL_FOR_RELEASE }}';
  }

  if (kind === 'sync') {
    const params = job.with.sync_params_without_dest;
    if (typeof params === 'string') {
      job.with.sync_params_without_dest = params.replace('sync ', '');
    }
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
  if (orgWorkflowCall && config.repository?.startsWith('github:WillBooster/')) {
    job.uses = `WillBooster/reusable-workflows/.github/workflows/${orgWorkflowCall.workflowName}.${orgWorkflowCall.extension}@${orgWorkflowCall.ref}`;
  } else if (orgWorkflowCall && config.repository?.startsWith('github:WillBoosterLab/')) {
    job.uses = `WillBoosterLab/reusable-workflows/.github/workflows/${orgWorkflowCall.workflowName}.${orgWorkflowCall.extension}@${orgWorkflowCall.ref}`;
  }

  // Remove redundant parameters
  if (job.with.dot_env_path === '.env') {
    delete job.with.dot_env_path;
  }

  // Don't use `fly deploy --json` since it causes an error
  if (kind.startsWith('deploy') && secrets?.FLY_API_TOKEN && typeof job.with.deploy_command === 'string') {
    job.with.deploy_command = job.with.deploy_command.replace(/\s+--json/, '');
  }
  if (config.doesContainDockerfile && !job.with.ci_label && kind.startsWith('test')) {
    job.with.ci_label = 'large';
  }
  // Because github.event.repository.private is always true if job is scheduled
  if (kind === 'release' || kind.startsWith('test') || kind.startsWith('deploy')) {
    if (config.isPublicRepo) {
      job.with.github_hosted_runner = true;
    }
  } else {
    delete job.with.github_hosted_runner;
  }

  if (Object.keys(job.with).length > 0) {
    sortKeys(job.with);
  } else {
    delete job.with;
  }
  if (secrets) {
    if (Object.keys(secrets).length > 0) {
      // Move secrets prop after with prop
      const newSecrets = sortKeys(secrets);
      delete job.secrets;
      job.secrets = newSecrets;
    } else {
      delete job.secrets;
    }
  }
}

function generateAutofixWorkflow(config: PackageConfig): Workflow {
  // No fnox setup or FNOX_AGE_KEY here on purpose: autofix only runs cleanup/build (never app
  // code needing secrets), it has never received DOT_ENV either, and public-repo autofix runs on
  // fork PRs where exposing a decryption secret would be unsafe. wb degrades gracefully (warns
  // and proceeds without fnox variables) when fnox is unavailable.
  const steps: Step[] = [
    { uses: 'actions/checkout@v6' },
    { uses: 'actions/setup-node@v6', with: { 'check-latest': true, 'node-version': 'lts/*' } },
    { uses: 'oven-sh/setup-bun@v2', with: { 'bun-version': 'latest' } },
    { run: 'bun install' },
    { run: 'bun run cleanup' },
  ];
  if (config.packageJson?.scripts?.build) {
    steps.push({ run: 'bun run build' });
  }
  steps.push({ uses: 'autofix-ci/action@c5b2d67aa2274e7b5a18224e8171550871fc7e4a' });

  const autofixWorkflow = structuredClone(publicRepoAutofixWorkflow);
  const autofixJob = autofixWorkflow.jobs.autofix ?? { 'runs-on': 'ubuntu-latest' };
  autofixWorkflow.jobs.autofix = { ...autofixJob, steps };
  return autofixWorkflow;
}

async function writeYaml(newSettings: Workflow, filePath: string): Promise<void> {
  const yamlText = removeTrailingSpaces(
    yaml.dump(newSettings, { lineWidth: -1, noCompatMode: true, styles: { '!!null': 'empty' } })
  );
  await fsUtil.writeFileConfined(filePath, yamlText);
}

function removeTrailingSpaces(text: string): string {
  // js-yaml emits valueless GitHub Actions events as `event: ` when using the empty null style.
  return text.replaceAll(/[ \t]+$/gm, '');
}
