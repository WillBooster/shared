import childProcess from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { buildWb } from '../helpers/build.js';

const binIndexPath = fileURLToPath(new URL('../../bin/index.js', import.meta.url));
const wbPackageDirPath = fileURLToPath(new URL('../..', import.meta.url));
// The released CLI runs under node (bin/index.js's shebang), not the bun test runner's runtime.
const nodePath = Bun.which('node');
if (!nodePath) throw new Error('node must be on PATH.');

beforeAll(buildWb, 120_000);
setDefaultTimeout(30_000);

const safeUpdate = { summary: 'Update app deploy.healthcheckPath', severity: 'safe', kind: 'resource.update' };
const safeVariableSet = { summary: 'Set variable app.ARCH', severity: 'safe', kind: 'variable.set' };

describe('wb deploy for .railway/railway.ts', () => {
  let projectDirPath: string;

  beforeEach(async () => {
    projectDirPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wb-deploy-railway-test-')));
    await createRailwayProject(projectDirPath);
  });

  afterEach(async () => {
    await fs.rm(projectDirPath, { force: true, recursive: true });
  });

  it('checks the plan of every environment on --dry-run without changing Railway', () => {
    const result = runWb(projectDirPath, ['deploy', '--dry-run'], [safeUpdate], { WB_ENV: 'test' });

    expect(result.status).toBe(0);
    const calls = readCalls(projectDirPath);
    expect(calls.map((call) => call.args.slice(0, 2).join(' '))).toEqual([
      'environment list',
      'config plan',
      'config plan',
    ]);
    expect(calls.filter((call) => call.args[0] === 'config').map((call) => call.env.WB_ENV)).toEqual([
      'staging',
      'production',
    ]);
  });

  it('rejects a plan with a variable deletion or a volume detachment before changing Railway', () => {
    const result = runWb(
      projectDirPath,
      ['deploy'],
      [
        safeUpdate,
        { summary: 'Delete variable app.OLD_KEY', severity: 'destructive', kind: 'variable.delete' },
        { summary: 'Update app volumeAttachments.data.mountPath', severity: 'destructive', kind: 'resource.update' },
      ],
      { WB_ENV: 'production' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('- Delete variable app.OLD_KEY');
    expect(result.stderr).toContain('- Update app volumeAttachments.data.mountPath');
    expect(readCalls(projectDirPath).map((call) => call.args[0])).toEqual(['environment', 'config']);
  });

  it('rejects a plan artifact marked destructive even when its changes look safe', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_PLAN_DESTRUCTIVE: '1',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('marked destructive');
    expect(readCalls(projectDirPath).map((call) => call.args[0])).toEqual(['environment', 'config']);
  });

  it('refuses to deploy when fnox cannot resolve a secret', async () => {
    const fnoxPath = path.join(projectDirPath, 'fnox.toml');
    const fnoxToml = await fs.readFile(fnoxPath, 'utf8');
    await fs.writeFile(
      fnoxPath,
      fnoxToml.replace(
        '[secrets]\n',
        '[secrets]\nBROKEN_SECRET = { provider = "age", value = "not-an-age-ciphertext" }\n'
      )
    );

    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], { WB_ENV: 'production' });

    expect(result.status).not.toBe(0);
    expect(readCalls(projectDirPath).map((call) => call.args[0])).not.toContain('up');
    expect(readCalls(projectDirPath).map((call) => call.args[0])).not.toContain('variables');
  });

  it('deploys when a production key Railway supplies is not exported by fnox', async () => {
    const fnoxPath = path.join(projectDirPath, 'fnox.toml');
    const fnoxToml = await fs.readFile(fnoxPath, 'utf8');
    await fs.writeFile(
      fnoxPath,
      fnoxToml
        .replace('[secrets]\n', '[secrets]\nDATABASE_URL = { default = "file:./dev.db" }\n')
        .replace('[profiles.production.secrets]\n', '[profiles.production.secrets]\nDATABASE_URL = { env = false }\n')
    );

    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], { WB_ENV: 'production' });

    expect(result.status).toBe(0);
    expect(readCalls(projectDirPath).map((call) => call.args[0])).toContain('up');
  });

  it('plans every environment on --dry-run before failing', () => {
    const result = runWb(
      projectDirPath,
      ['deploy', '--dry-run'],
      [{ summary: 'Delete variable app.OLD_KEY', severity: 'destructive', kind: 'variable.delete' }],
      { WB_ENV: 'test' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('The Railway plan for production contains');
    expect(result.stderr).toContain('The Railway plan for staging contains');
  });

  it('rejects resource creation and unknown change kinds', () => {
    const result = runWb(
      projectDirPath,
      ['deploy', '--dry-run'],
      [
        { summary: 'Create service ap', severity: 'safe', kind: 'resource.create' },
        { summary: 'Something new', severity: 'safe', kind: 'future.kind' },
      ],
      { WB_ENV: 'test' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('- Create service ap');
    expect(result.stderr).toContain('- Something new');
  });

  it('syncs fnox values, applies the re-checked plan, and deploys the mapped service', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate, safeVariableSet], {
      WB_ENV: 'production',
      WB_VERSION: 'v1.2.3',
    });

    expect(result.status).toBe(0);
    const calls = readCalls(projectDirPath);
    expect(calls.map((call) => call.args.slice(0, 2).join(' '))).toEqual([
      'environment list',
      'config plan',
      'variables --skip-deploys',
      'config plan',
      'deployment list',
      'config apply',
      'deployment list',
      'up --detach',
      'deployment list',
      'logs deployment-new',
    ]);
    const [, firstPlan, variables, secondPlan, , apply, , up, deploymentList, logs] = calls;
    expect(firstPlan?.env).toMatchObject({
      RAILWAY_PROJECT_ID: 'project-1',
      RAILWAY_ENVIRONMENT_ID: 'env-production',
      WB_ENV: 'production',
    });
    expect(firstPlan?.env._).toBe(path.join(projectDirPath, 'node_modules/@railway/cli/bin/railway'));
    expect(JSON.parse(firstPlan?.env.WB_RAILWAY_VARIABLE_NAMES ?? '')).toEqual([
      'APP_URL',
      'PRODUCTION_ONLY',
      'WB_ENV',
      'WB_VERSION',
    ]);
    const setValues = variables?.args.filter((_, index) => variables.args[index - 1] === '--set');
    expect(variables?.args).toEqual(expect.arrayContaining(['--service=app', '--environment=production']));
    expect(setValues?.toSorted()).toEqual([
      'APP_URL=http://localhost',
      'PRODUCTION_ONLY=value',
      'WB_ENV=production',
      'WB_VERSION=v1.2.3',
    ]);
    // The first plan is invalidated by the variable sync, so only the re-checked plan may be applied.
    expect(readPlanPath(secondPlan)).not.toBe(readPlanPath(firstPlan));
    expect(apply?.args.slice(2)).toEqual(['--plan', readPlanPath(secondPlan), '--yes']);
    expect(fsSync.existsSync(path.dirname(readPlanPath(secondPlan)))).toBe(false);
    const targetArgs = ['--project=project-1', '--environment=production', '--service=app'];
    expect(up?.args).toEqual(['up', '--detach', '--json', ...targetArgs]);
    expect(deploymentList?.args).toEqual(['deployment', 'list', '--json', '--limit=20', ...targetArgs]);
    expect(logs?.args).toEqual(['logs', 'deployment-new', '--build', '--lines=1000', ...targetArgs]);
    expect(result.stdout).toContain('fake build log');
  });

  it('skips config apply when the re-checked plan has no changes, so railway up is the only deployment', () => {
    // The first plan has a change that the variable sync resolves, so only the re-checked plan is empty.
    const result = runWb(projectDirPath, ['deploy'], [safeVariableSet], {
      WB_ENV: 'production',
      FAKE_RAILWAY_RECHECKED_PLAN: JSON.stringify({ changeSet: { changes: [] }, destructive: false }),
    });

    expect(result.status).toBe(0);
    expect(readCalls(projectDirPath).map((call) => call.args.slice(0, 2).join(' '))).toEqual([
      'environment list',
      'config plan',
      'variables --skip-deploys',
      'config plan',
      'up --detach',
      'deployment list',
      'logs deployment-new',
    ]);
  });

  it('applies a re-checked plan without changes when it claims IaC ownership', () => {
    const result = runWb(projectDirPath, ['deploy'], [], { WB_ENV: 'production', FAKE_RAILWAY_PLAN_CLAIM: '1' });

    expect(result.status).toBe(0);
    expect(readCalls(projectDirPath).map((call) => call.args.slice(0, 2).join(' '))).toEqual([
      'environment list',
      'config plan',
      'variables --skip-deploys',
      'config plan',
      'deployment list',
      'config apply',
      'deployment list',
      'up --detach',
      'deployment list',
      'logs deployment-new',
    ]);
  });

  it('runs railway up only after the deployment triggered by config apply appears', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_APPLIED_DEPLOYMENT_DELAY: '2',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('config apply triggered Railway deployment deployment-applied (BUILDING)');
    expect(result.stdout).toContain('deployment-new: SUCCESS');
    expect(readCalls(projectDirPath).map((call) => call.args.slice(0, 2).join(' '))).toEqual([
      'environment list',
      'config plan',
      'variables --skip-deploys',
      'config plan',
      'deployment list',
      'config apply',
      'deployment list',
      'deployment list',
      'deployment list',
      'up --detach',
      'deployment list',
      'logs deployment-new',
    ]);
  }, 60_000);

  it('succeeds once the created deployment reaches SUCCESS despite failed status polls and log fetches', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_DEPLOYMENT_STATUSES: 'ERROR,BUILDING,SUCCESS',
      FAKE_RAILWAY_LOGS_FAIL: '1',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deployment-new: BUILDING');
    expect(result.stdout).toContain('deployment-new: SUCCESS');
    expect(readCalls(projectDirPath).filter((call) => call.args[0] === 'up')).toHaveLength(1);
  }, 60_000);

  it('fails with the build and deploy logs when the created deployment fails', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_DEPLOYMENT_STATUSES: 'FAILED',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Railway deployment deployment-new ended with FAILED.');
    expect(result.stdout).toContain('fake build log');
    expect(result.stdout).toContain('fake deploy log');
  });

  it('keeps waiting while the created deployment is missing from the newest deployments', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_DEPLOYMENT_STATUSES: 'DEPLOYING,MISSING,SUCCESS',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deployment-new: SUCCESS');
  }, 60_000);

  it('fails when the created deployment does not finish within the timeout', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_DEPLOYMENT_STATUSES: 'BUILDING',
      WB_RAILWAY_DEPLOY_TIMEOUT_SECONDS: '1',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('deployment-new did not finish within 1 seconds (last status: BUILDING)');
    expect(result.stderr).not.toContain('railway deployment list failed');
  });

  it('fails at the timeout even when a status poll never returns', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_DEPLOYMENT_STATUSES: 'HANG',
      WB_RAILWAY_DEPLOY_TIMEOUT_SECONDS: '1',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('deployment-new did not finish within 1 seconds (last status: not listed)');
    expect(result.stderr).not.toContain('TimeoutNegativeWarning');
    expect(result.stderr).not.toContain('railway deployment list');
  });

  it('reports a failed variable sync with the CLI error but never its stdout', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_VARIABLES_FAIL: '1',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('railway variables error');
    expect(result.stderr).toContain('Failed to sync environment variables to Railway');
    expect(`${result.stdout}${result.stderr}`).not.toContain('SECRET_VALUE_LISTING');
    expect(readCalls(projectDirPath).map((call) => call.args[0])).not.toContain('up');
  });

  it('ignores RAILWAY_ENVIRONMENT_ID and RAILWAY_SERVICE_ID inherited from a deploy workflow', () => {
    const result = runWb(projectDirPath, ['deploy', '--dry-run'], [safeUpdate], {
      WB_ENV: 'production',
      RAILWAY_ENVIRONMENT_ID: 'production',
      RAILWAY_SERVICE_ID: 'service-from-workflow',
    });

    expect(result.status).toBe(0);
    const calls = readCalls(projectDirPath);
    for (const call of calls) expect(call.env.RAILWAY_SERVICE_ID).toBeUndefined();
    expect(calls.map((call) => call.env.RAILWAY_ENVIRONMENT_ID)).toEqual([undefined, 'env-staging', 'env-production']);
  });

  it('refuses a railwayTarget without any environment', async () => {
    await fs.writeFile(
      path.join(projectDirPath, '.railway', 'railway.ts'),
      `export const railwayTarget = { projectId: 'project-1', services: {} };\n`
    );

    const result = runWb(projectDirPath, ['deploy', '--dry-run'], [safeUpdate], { WB_ENV: 'test' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('declare at least one <environment>: <service name>');
    expect(readCalls(projectDirPath)).toEqual([]);
  });

  it('refuses a deploy workflow RAILWAY_PROJECT_ID that differs from railwayTarget', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      RAILWAY_PROJECT_ID: 'other-project',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('differs from railwayTarget.projectId');
    expect(readCalls(projectDirPath)).toEqual([]);
  });
});

interface RailwayCall {
  args: string[];
  env: Record<string, string>;
}

function runWb(
  projectDirPath: string,
  args: string[],
  planChanges: { summary: string; severity: string; kind: string }[],
  env: Record<string, string> = {}
): childProcess.SpawnSyncReturns<string> {
  return childProcess.spawnSync(nodePath!, [binIndexPath, ...args], {
    cwd: projectDirPath,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      FAKE_RAILWAY_PLAN: JSON.stringify({
        changeSet: { changes: planChanges },
        destructive:
          env.FAKE_RAILWAY_PLAN_DESTRUCTIVE === '1' || planChanges.some((change) => change.severity === 'destructive'),
        // Like the real CLI, the artifact omits `claim` unless it is true.
        ...(env.FAKE_RAILWAY_PLAN_CLAIM === '1' && { claim: true }),
      }),
      ...env,
    },
  });
}

function readPlanPath(call: RailwayCall | undefined): string {
  return call?.args[call.args.indexOf('--out') + 1] ?? '';
}

function readCalls(projectDirPath: string): RailwayCall[] {
  const logPath = path.join(projectDirPath, 'railway-calls.jsonl');
  return fsSync.existsSync(logPath)
    ? fsSync
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as RailwayCall)
    : [];
}

async function createRailwayProject(projectDirPath: string): Promise<void> {
  await fs.mkdir(path.join(projectDirPath, '.git'), { recursive: true });
  await fs.writeFile(path.join(projectDirPath, 'package.json'), JSON.stringify({ name: 'railway-fixture' }));
  await fs.writeFile(
    path.join(projectDirPath, 'fnox.toml'),
    `[secrets]
WB_ENV = { default = "development" }
APP_URL = { default = "http://localhost" }
RAILWAY_RUN_UID = { default = "0" }
NOT_EXPORTED_IN_PRODUCTION = { default = "value" }

[profiles.production.secrets]
WB_ENV = { default = "production" }
PRODUCTION_ONLY = { default = "value" }
NOT_EXPORTED_IN_PRODUCTION = { default = "value", env = false }

[profiles.staging.secrets]
WB_ENV = { default = "staging" }

[profiles.test.secrets]
WB_ENV = { default = "test" }
`
  );
  await fs.mkdir(path.join(projectDirPath, '.railway'));
  // The fixture mirrors a real file: `railwayVariables` runs inside the default export, which only the
  // Railway CLI evaluates, so `wb` can import the module for `railwayTarget` before passing the names.
  await fs.writeFile(
    path.join(projectDirPath, '.railway', 'railway.ts'),
    `import { railwayVariables } from '@willbooster/wb/bin/railway.js';

export const railwayTarget = { projectId: 'project-1', services: { staging: 'app-staging', production: 'app' } };

export default () => ({ env: railwayVariables(() => ({ type: 'preserve' }), { ARCH: 'x86_64' }) });
`
  );
  await fs.mkdir(path.join(projectDirPath, 'node_modules', '@willbooster'), { recursive: true });
  await fs.symlink(wbPackageDirPath, path.join(projectDirPath, 'node_modules', '@willbooster', 'wb'));
  const cliDirPath = path.join(projectDirPath, 'node_modules', '@railway', 'cli');
  await fs.mkdir(path.join(cliDirPath, 'bin'), { recursive: true });
  await fs.writeFile(path.join(cliDirPath, 'package.json'), JSON.stringify({ name: '@railway/cli' }));
  await fs.writeFile(
    path.join(cliDirPath, 'bin', 'railway'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = ${JSON.stringify(path.join(projectDirPath, 'railway-calls.jsonl'))};
fs.appendFileSync(logPath, JSON.stringify({ args, env: process.env }) + '\\n');
if (args[0] === 'environment') {
  console.log(JSON.stringify({ environments: [{ id: 'env-production', name: 'production' }, { id: 'env-staging', name: 'staging' }] }));
} else if (args[0] === 'variables' && process.env.FAKE_RAILWAY_VARIABLES_FAIL) {
  console.log('SECRET_VALUE_LISTING');
  console.error('railway variables error');
  process.exit(1);
} else if (args[0] === 'config' && args[1] === 'plan') {
  const isRecheck = fs.readFileSync(logPath, 'utf8').trim().split('\\n').some((line) => JSON.parse(line).args[0] === 'variables');
  // Like the real CLI, the --out artifact and the stdout report have different shapes.
  fs.writeFileSync(
    args[args.indexOf('--out') + 1],
    (isRecheck && process.env.FAKE_RAILWAY_RECHECKED_PLAN) || process.env.FAKE_RAILWAY_PLAN
  );
  console.log(JSON.stringify({ ok: true, changeSet: { changes: [] }, diagnostics: [] }));
} else if (args[0] === 'up') {
  console.log(JSON.stringify({ deploymentId: 'deployment-new', logsUrl: 'https://railway.example/logs' }));
} else if (args[0] === 'deployment') {
  const calls = fs.readFileSync(logPath, 'utf8').trim().split('\\n').map((line) => JSON.parse(line).args);
  const applyIndex = calls.findIndex((callArgs) => callArgs[0] === 'config' && callArgs[1] === 'apply');
  const upIndex = calls.findIndex((callArgs) => callArgs[0] === 'up');
  // Like Railway, the deployment that config apply triggers is created after the apply returns: here, at
  // the (FAKE_RAILWAY_APPLIED_DEPLOYMENT_DELAY + 1)-th list call after the apply. The newer of it and the
  // uploaded deployment supersedes the other.
  const listIndexesAfterApply = applyIndex < 0 ? [] : calls.flatMap((callArgs, index) => (index > applyIndex && callArgs[0] === 'deployment' ? [index] : []));
  const appliedIndex = listIndexesAfterApply[Number(process.env.FAKE_RAILWAY_APPLIED_DEPLOYMENT_DELAY || 0)];
  const statuses = (process.env.FAKE_RAILWAY_DEPLOYMENT_STATUSES || 'SUCCESS').split(',');
  const pollCount = upIndex < 0 ? 0 : calls.filter((callArgs, index) => index > upIndex && callArgs[0] === 'deployment').length;
  const status = statuses[Math.min(pollCount, statuses.length) - 1];
  if (status === 'HANG') {
    setInterval(() => {}, 1000);
  } else if (status === 'ERROR') {
    console.error('railway deployment list error');
    process.exit(1);
  } else {
    const deployments = [{ id: 'deployment-old', status: 'SUCCESS', createdAt: '2026-01-01T00:00:00Z', meta: null }];
    if (appliedIndex !== undefined) {
      deployments.unshift({ id: 'deployment-applied', status: upIndex >= 0 && appliedIndex < upIndex ? 'REMOVED' : 'BUILDING', createdAt: '2026-01-02T00:00:00Z', meta: null });
    }
    if (upIndex >= 0 && status !== 'MISSING') {
      const superseded = applyIndex >= 0 && (appliedIndex === undefined || appliedIndex > upIndex);
      deployments.unshift({ id: 'deployment-new', status: superseded ? 'REMOVED' : status, createdAt: '2026-01-03T00:00:00Z', meta: null });
    }
    console.log(JSON.stringify(deployments, null, 2));
  }
} else if (args[0] === 'logs') {
  if (process.env.FAKE_RAILWAY_LOGS_FAIL) process.exit(1);
  console.log(args.includes('--build') ? 'fake build log' : 'fake deploy log');
}
`,
    { mode: 0o755 }
  );
}
