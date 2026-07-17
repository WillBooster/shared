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
    const fileNameSet = new Set([
      'test.yml',
      'autofix.yml',
      'semantic-pr.yml',
      'close-comment.yml',
      ...entries
        .filter(
          (dirent) => dirent.isFile() && dirent.name.endsWith('.yml') && !isObsoleteGenPrWorkflowFileName(dirent.name)
        )
        .map((dirent) => dirent.name),
    ]);
    if (rootConfig.depending.semanticRelease) {
      fileNameSet.add('release.yml');
    }
    if (rootConfig.cargoTomlDirPaths.length > 0) {
      fileNameSet.add('test-rust.yml');
    }
    if (!rootConfig.isPublicRepo) {
      // The reusable test workflow already fixes and pushes code on private repos,
      // so a separate autofix workflow only duplicates the same process.
      fileNameSet.delete('autofix.yml');
      await promisePool.run(() => fs.promises.rm(path.join(workflowsPath, 'autofix.yml'), { force: true }));
    }

    for (const fileName of fileNameSet) {
      // 実際はKnownKind以外の値も代入されることに注意
      const kind = path.basename(fileName, '.yml') as KnownKind;
      await promisePool.run(() => writeWorkflowYaml(rootConfig, workflowsPath, kind));
    }
  });
}

export function isReusableWorkflowsRepo(repository?: string): boolean {
  return repository?.endsWith('/reusable-workflows') ?? false;
}

function isObsoleteGenPrWorkflowFileName(fileName: string): boolean {
  return /^gen-pr(?:-.+)?\.ya?ml$/u.test(fileName);
}

async function writeWorkflowYaml(config: PackageConfig, workflowsPath: string, kind: KnownKind): Promise<void> {
  const filePath = path.join(workflowsPath, `${kind}.yml`);
  const deployProductionWorkflowExists = fs.existsSync(path.join(workflowsPath, 'deploy-production.yml'));

  if (kind === 'autofix') {
    await writeYaml(generateAutofixWorkflow(config), filePath);
    return;
  }

  // A test-rust.yml in a repo without Rust code is a custom workflow that merely shares the name; leave it alone.
  if (kind === 'test-rust' && config.cargoTomlDirPaths.length === 0) return;

  let newSettings = structuredClone(kind in workflows ? workflows[kind as keyof typeof workflows] : {}) as Workflow;

  try {
    const oldContent = await fs.promises.readFile(filePath, 'utf8');
    const oldSettings = yaml.load(oldContent) as Workflow;
    newSettings = merge.all([newSettings, oldSettings, newSettings], { arrayMerge: combineMerge }) as Workflow;
  } catch {
    // do nothing
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

  if (kind === 'release' && newSettings.jobs.release && deployProductionWorkflowExists) {
    newSettings.permissions ??= {};
    newSettings.permissions.actions = 'write';
    newSettings.jobs.release.with ??= {};
    newSettings.jobs.release.with.trigger_deploy_workflow = 'deploy-production.yml';
  }

  let isReusableWorkflow = false;
  for (const job of Object.values(newSettings.jobs)) {
    // Ignore non-reusable workflows
    if (!job.uses?.includes('/reusable-workflows/')) continue;

    normalizeJob(config, job, kind);
    isReusableWorkflow = true;
  }
  if (!isReusableWorkflow) return;

  switch (kind) {
    case 'release': {
      if (newSettings.on?.schedule) {
        delete newSettings.on.push;
      } else if (newSettings.on?.push && config.release.branches.length > 0) {
        newSettings.on.push.branches = config.release.branches;
      } else {
        // Don't use release.yml if release branch is not specified
        await fs.promises.rm(path.join(workflowsPath, 'release.yml'), { force: true });
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
    await fs.promises.rm(path.join(workflowsPath, 'sync-init.yml'), { force: true });
    if (!newSettings.jobs.sync?.with) return;

    // Generate sync-force.yml based on sync.yml if it exists.
    newSettings.jobs['sync-force'] = newSettings.jobs.sync;
    const params = newSettings.jobs.sync.with.sync_params_without_dest;
    if (typeof params !== 'string') return;

    newSettings.jobs.sync.with.sync_params_without_dest = `--force ${params}`;
    newSettings.name = 'Force to Sync';
    newSettings.on = { workflow_dispatch: null };
    delete newSettings.jobs.sync;
    await writeYaml(newSettings, path.join(workflowsPath, 'sync-force.yml'));
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
  const calledReusableWorkflow = /\/reusable-workflows\/\.github\/workflows\/([^/@]+?)\.ya?ml@/u.exec(
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
