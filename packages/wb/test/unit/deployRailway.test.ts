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
      'up --json',
    ]);
    const [, firstPlan, variables, secondPlan, , apply, , up] = calls;
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
    expect(up?.args).toEqual(['up', '--json', ...targetArgs]);
    // Only the message of each JSON log line is printed, and the final status line is not.
    expect(result.stdout).toContain(
      'fake build log 1\nunpacking archive\n\u001B[32mfake build log 2\u001B[0m\nfake build log 3\n[production] The Railway deployment succeeded.'
    );
    expect(result.stdout).not.toContain('"status"');
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
      'up --json',
    ]);
  });

  it('re-plans, re-checks, and applies a fresh plan when Railway rejects the plan as stale', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_APPLY_RESULTS: 'STALE',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Railway rejected the plan as stale (apply attempt 1/3)');
    expect(result.stdout).toContain('config apply triggered Railway deployment deployment-applied');
    const calls = readCalls(projectDirPath);
    expect(calls.map((call) => call.args.slice(0, 2).join(' '))).toEqual([
      'environment list',
      'config plan',
      'variables --skip-deploys',
      'config plan',
      'deployment list',
      'config apply',
      'config plan',
      'deployment list',
      'config apply',
      'deployment list',
      'up --json',
    ]);
    const [rejectedApply, freshPlan, , apply] = calls.slice(5);
    expect(apply?.args.slice(2)).toEqual(['--plan', readPlanPath(freshPlan), '--yes']);
    expect(rejectedApply?.args[3]).not.toBe(readPlanPath(freshPlan));
  }, 60_000);

  it('fails without re-planning when config apply fails for another reason', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_APPLY_RESULTS: 'ERROR',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('railway config apply error');
    expect(result.stderr).toContain('railway config apply failed (exit 1).');
    expect(result.stderr).not.toContain('stale');
    const commands = readCalls(projectDirPath).map((call) => call.args.slice(0, 2).join(' '));
    expect(commands.slice(commands.indexOf('config apply'))).toEqual(['config apply']);
  });

  it('runs railway up only after the deployment triggered by config apply appears', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_APPLIED_DEPLOYMENT_DELAY: '2',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('config apply triggered Railway deployment deployment-applied (BUILDING)');
    expect(result.stdout).toContain('The Railway deployment succeeded.');
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
      'up --json',
    ]);
  }, 60_000);

  it('retries a failed deployment list before config apply and a stalled one after it', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_PRE_UP_LIST_RESULTS: 'ERROR,,HANG',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('railway deployment list failed (exit 1)');
    expect(result.stderr).toContain('railway deployment list did not answer within 15 seconds.');
    expect(result.stdout).toContain('config apply triggered Railway deployment deployment-applied');
    expect(result.stdout).toContain('The Railway deployment succeeded.');
  }, 60_000);

  // Whether Railway deploys the service for an ownership claim without changes is undocumented, so this
  // covers the case where it does not.
  it('applies a claim-only plan and runs railway up with a warning when no deployment appears', () => {
    const result = runWb(projectDirPath, ['deploy'], [], {
      WB_ENV: 'production',
      FAKE_RAILWAY_PLAN_CLAIM: '1',
      FAKE_RAILWAY_APPLIED_DEPLOYMENT_DELAY: 'never',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('No deployment triggered by config apply was seen within 60 seconds');
    expect(result.stdout).toContain('The Railway deployment succeeded.');
    const commands = readCalls(projectDirPath).map((call) => call.args.slice(0, 2).join(' '));
    expect(commands).toContain('config apply');
    expect(commands.indexOf('config apply')).toBeLessThan(commands.indexOf('up --json'));
    expect(commands.filter((command) => command === 'up --json')).toHaveLength(1);
  }, 90_000);

  it('finds the created deployment when railway up ends without the status line, backing off when rate-limited', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_UP: 'DISCONNECT',
      FAKE_RAILWAY_DEPLOYMENT_STATUSES: 'RATELIMIT,SUCCESS',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("railway up ended (exit 1) without reporting the deployment's result");
    expect(result.stderr).toContain('Railway rate-limited the status check; checking again in 60 seconds.');
    expect(result.stdout).toContain('Railway deployment deployment-new: SUCCESS');
    // The build logs are fetched once after the verdict.
    expect(result.stdout).toContain('fake build log 4\n');
    expect(result.stdout).toContain('Railway deployment deployment-new succeeded.');
    const calls = readCalls(projectDirPath);
    const commands = calls.map((call) => call.args.slice(0, 2).join(' '));
    expect(commands.slice(commands.indexOf('up --json'))).toEqual([
      'up --json',
      'deployment list',
      'deployment list',
      'logs deployment-new',
    ]);
    const [firstCheck, secondCheck, logs] = calls.slice(commands.indexOf('up --json') + 1);
    expect((secondCheck?.time ?? 0) - (firstCheck?.time ?? 0)).toBeGreaterThanOrEqual(60_000);
    expect(logs?.args).toEqual(expect.arrayContaining(['--build', '--json', '--lines=5000']));
  }, 120_000);

  it.each<{ name: string; env: Record<string, string>; message: string }>([
    { name: 'none', env: { FAKE_RAILWAY_DEPLOYMENT_STATUSES: 'MISSING' }, message: 'but found 0;' },
    {
      name: 'more than one',
      env: { FAKE_RAILWAY_OTHER_DEPLOYMENT: '1' },
      message: 'but found 2 (deployment-other, deployment-new);',
    },
  ])('fails when $name of the deployments was created since railway up started', ({ env, message }) => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_UP: 'DISCONNECT',
      ...env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Expected one Railway deployment created since railway up started, ${message}`);
    const commands = readCalls(projectDirPath).map((call) => call.args.slice(0, 2).join(' '));
    expect(commands.slice(commands.indexOf('up --json'))).toEqual(['up --json', 'deployment list']);
  });

  it('fails when railway up reports that the deployment failed', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_UP: 'FAILED',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('fake build log 3');
    expect(result.stderr).toContain('railway up reported the Railway deployment as failed (exit 1).');
    expect(readCalls(projectDirPath).at(-1)?.args[0]).toBe('up');
  });

  it('fails when the created deployment does not finish within the timeout', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_UP: 'HANG',
      FAKE_RAILWAY_DEPLOYMENT_STATUSES: 'BUILDING',
      WB_RAILWAY_DEPLOY_TIMEOUT_SECONDS: '1',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('railway up ended (stopped at the deploy timeout)');
    expect(result.stderr).toContain('deployment-new did not finish within 1 seconds (last status: BUILDING)');
  });

  it('fails at the timeout even when a status check never returns', () => {
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], {
      WB_ENV: 'production',
      FAKE_RAILWAY_UP: 'HANG',
      FAKE_RAILWAY_DEPLOYMENT_STATUSES: 'HANG',
      WB_RAILWAY_DEPLOY_TIMEOUT_SECONDS: '1',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not finish within 1 seconds (last status: not listed)');
    expect(result.stderr).toContain('railway deployment list did not answer within 15 seconds.');
    expect(result.stderr).not.toContain('TimeoutNegativeWarning');
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
  time: number;
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
fs.appendFileSync(logPath, JSON.stringify({ args, env: process.env, time: Date.now() }) + '\\n');
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
} else if (args[0] === 'config' && args[1] === 'apply') {
  const applyCount = fs.readFileSync(logPath, 'utf8').trim().split('\\n').filter((line) => JSON.parse(line).args[1] === 'apply').length;
  // FAKE_RAILWAY_APPLY_RESULTS injects failures into the apply calls, in call order; a rejected apply creates no deployment.
  const applyResult = (process.env.FAKE_RAILWAY_APPLY_RESULTS || '').split(',')[applyCount - 1];
  if (applyResult === 'STALE') {
    console.error('Error: The environment changed since this plan was computed. Run plan again.');
    process.exit(1);
  } else if (applyResult === 'ERROR') {
    console.error('railway config apply error');
    process.exit(1);
  }
} else if (args[0] === 'up') {
  // Like railway up --json, each build log line is a JSON object, and progress lines also carry a status.
  // FAKE_RAILWAY_UP selects how it ends: FAILED reports a failed deployment, DISCONNECT ends without the
  // final status line, and HANG never ends.
  const mode = process.env.FAKE_RAILWAY_UP || '';
  const log = (message, extra) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', message, ...extra }));
  log('fake build log 1');
  log('unpacking archive', { source: 'railway.progress', status: 'complete' });
  if (mode === 'DISCONNECT') {
    console.error(JSON.stringify({ error: 'connection reset' }));
    process.exit(1);
  }
  if (mode === 'HANG') {
    setInterval(() => {}, 1000);
  } else {
    log('\\u001b[32mfake build log 2\\u001b[0m\\r\\n');
    log('fake build log 3');
    console.log(JSON.stringify(mode === 'FAILED' ? { status: 'failed', error: 'build failed' } : { status: 'success' }));
    process.exit(mode === 'FAILED' ? 1 : 0);
  }
} else if (args[0] === 'deployment') {
  const calls = fs.readFileSync(logPath, 'utf8').trim().split('\\n').map((line) => JSON.parse(line).args);
  const applyResults = (process.env.FAKE_RAILWAY_APPLY_RESULTS || '').split(',');
  const applyIndexes = calls.flatMap((callArgs, index) => (callArgs[0] === 'config' && callArgs[1] === 'apply' ? [index] : []));
  const applyIndex = applyIndexes.find((_, ordinal) => !applyResults[ordinal]) ?? -1;
  const upIndex = calls.findIndex((callArgs) => callArgs[0] === 'up');
  // Like Railway, the deployment that config apply triggers is created after the apply returns: here, at
  // the (FAKE_RAILWAY_APPLIED_DEPLOYMENT_DELAY + 1)-th list call after the apply, or never when it is
  // 'never'. The newer of it and the uploaded deployment supersedes the other.
  const listIndexesAfterApply = applyIndex < 0 ? [] : calls.flatMap((callArgs, index) => (index > applyIndex && callArgs[0] === 'deployment' ? [index] : []));
  const appliedIndex = listIndexesAfterApply[Number(process.env.FAKE_RAILWAY_APPLIED_DEPLOYMENT_DELAY || 0)];
  const statuses = (process.env.FAKE_RAILWAY_DEPLOYMENT_STATUSES || 'SUCCESS').split(',');
  const pollCount = upIndex < 0 ? 0 : calls.filter((callArgs, index) => index > upIndex && callArgs[0] === 'deployment').length;
  // FAKE_RAILWAY_PRE_UP_LIST_RESULTS injects faults into the list calls before railway up, in call order.
  const preUpListCount = calls.filter((callArgs) => callArgs[0] === 'deployment').length;
  const status = upIndex < 0
    ? (process.env.FAKE_RAILWAY_PRE_UP_LIST_RESULTS || '').split(',')[preUpListCount - 1]
    : statuses[Math.min(pollCount, statuses.length) - 1];
  if (status === 'RATELIMIT') {
    console.error('Failed to fetch: You are being ratelimited. Please try again later');
    process.exit(1);
  } else if (status === 'HANG') {
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
      const applyTriggersDeployment = applyIndex >= 0 && process.env.FAKE_RAILWAY_APPLIED_DEPLOYMENT_DELAY !== 'never';
      const superseded = applyTriggersDeployment && (appliedIndex === undefined || appliedIndex > upIndex);
      const createdAt = new Date(JSON.parse(fs.readFileSync(logPath, 'utf8').trim().split('\\n')[upIndex]).time + 500).toISOString();
      deployments.unshift({ id: 'deployment-new', status: superseded ? 'REMOVED' : status, createdAt, meta: null });
      // FAKE_RAILWAY_OTHER_DEPLOYMENT adds a deployment that is also created after railway up started.
      if (process.env.FAKE_RAILWAY_OTHER_DEPLOYMENT) deployments.unshift({ id: 'deployment-other', status: 'BUILDING', createdAt, meta: null });
    }
    console.log(JSON.stringify(deployments, null, 2));
  }
} else if (args[0] === 'logs') {
  for (const message of ['fake build log 1', 'fake build log 2', 'fake build log 3', 'fake build log 4']) {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', message }));
  }
}
`,
    { mode: 0o755 }
  );
}
