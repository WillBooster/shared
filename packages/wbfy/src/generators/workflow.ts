// GitHub Actions valueless events such as `pull_request:` require YAML null values.
// oxlint-disable eslint-plugin-import/no-named-as-default-member -- Namespace YAML calls make load/dump usage clearer.
/* eslint-disable unicorn/no-null */

import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import yaml from 'js-yaml';

import { logger } from '../logger.js';
import { fsUtil } from '../utils/fsUtil.js';
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
    concurrency: {
      group: '${{ github.workflow }}',
      'cancel-in-progress': false,
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

export async function generateWorkflows(rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateWorkflow', async () => {
    if (isReusableWorkflowsRepo(rootConfig.repository)) {
      // Don't touch reusable-workflows repo because it hosts upstream workflow definitions.
      return;
    }

    const workflowsPath = path.resolve(rootConfig.dirPath, '.github', 'workflows');
    await fs.promises.mkdir(workflowsPath, { recursive: true });

    // Remove config of semantic pull request
    const semanticYmlPath = path.resolve(rootConfig.dirPath, '.github', 'semantic.yml');
    await promisePool.run(() => fs.promises.rm(semanticYmlPath, { force: true, recursive: true }));

    const entries = await fs.promises.readdir(workflowsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !isObsoleteGenPrWorkflowFileName(entry.name)) continue;
      await promisePool.run(() => fs.promises.rm(path.join(workflowsPath, entry.name), { force: true }));
    }
    // GitHub accepts both .yml and .yaml workflow files, and a workflow's file name is its public
    // identity (badge URLs, the workflow REST API, same-repository `uses:` references), so .yaml
    // files are processed under their own name instead of being renamed or silently left stale.
    // Each kind maps to the one file that carries it; when both spellings exist the .yml wins and
    // the .yaml twin is left untouched, since merging two workflow definitions is ambiguous.
    const fileNamesByKind = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name) || isObsoleteGenPrWorkflowFileName(entry.name)) continue;
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
        await promisePool.run(() => fs.promises.rm(path.join(workflowsPath, autofixFileName), { force: true }));
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

function isObsoleteGenPrWorkflowFileName(fileName: string): boolean {
  return /^gen-pr(?:-.+)?\.ya?ml$/u.test(fileName);
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
      if (!job.uses?.includes('/reusable-workflows/')) {
        delete newSettings.jobs[jobName];
      }
    }
    moveToBottom(newSettings, 'jobs');
  }

  if (kind.startsWith('deploy')) {
    newSettings = {
      ...newSettings,
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
    // Ignore non-reusable workflows
    if (!job.uses?.includes('/reusable-workflows/')) continue;

    normalizeJob(config, job, kind);
    isReusableWorkflow = true;
  }
  if (!isReusableWorkflow) return;

  // Deploy callers need no repository writes: the called reusable workflow inherits the caller's
  // token permissions, repositories default the token to write, and the reusable deploy workflow
  // at main performs no GITHUB_TOKEN writes. A top-level permissions block applies to EVERY job
  // and resets unspecified scopes to none, so inject the read-only default only when each job is
  // an @main call of the reusable deploy workflow — an inline job may need writes, a PINNED
  // callee follows an older revision whose write needs are unaudited, and run-script callers
  // execute arbitrary package scripts that may push commits. Only default it — a workflow that
  // declares its own permissions keeps them (OIDC deploys always do, for id-token).
  const jobs = Object.values(newSettings.jobs);
  if (
    !newSettings.permissions &&
    jobs.length > 0 &&
    jobs.every((job) => /\/reusable-workflows\/\.github\/workflows\/deploy\.ya?ml@main$/u.test(job.uses ?? ''))
  ) {
    newSettings.permissions = { contents: 'read' };
  }

  switch (kind) {
    case 'release': {
      if (newSettings.on?.schedule) {
        delete newSettings.on.push;
      } else if (newSettings.on?.push && config.release.branches.length > 0) {
        newSettings.on.push.branches = config.release.branches;
      } else {
        // Don't use the release workflow if release branch is not specified
        await fs.promises.rm(filePath, { force: true });
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
      await fs.promises.rm(path.join(workflowsPath, syncInitFileName), { force: true });
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

// The reusable workflows that declare FNOX_AGE_KEY and VERDACCIO_TOKEN under
// on.workflow_call.secrets (see WillBooster/reusable-workflows). Passing either secret to any
// other callee is a GitHub error.
const installCapableReusableWorkflows = new Set(['autofix', 'deploy', 'gen-pr', 'release', 'run-script', 'test']);

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
  const calledReusableWorkflow = /\/reusable-workflows\/\.github\/workflows\/([^/@]+?)\.ya?ml@main$/u.exec(
    job.uses ?? ''
  )?.[1];
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

  if (config.repository?.startsWith('github:WillBooster/')) {
    job.uses = job.uses?.replace('WillBoosterLab/', 'WillBooster/');
  } else if (config.repository?.startsWith('github:WillBoosterLab/')) {
    job.uses = job.uses?.replace('WillBooster/', 'WillBoosterLab/');
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
