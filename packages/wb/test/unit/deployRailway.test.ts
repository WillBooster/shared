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
      'production',
      'staging',
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
    const result = runWb(projectDirPath, ['deploy'], [safeUpdate], { WB_ENV: 'production', WB_VERSION: 'v1.2.3' });

    expect(result.status).toBe(0);
    const calls = readCalls(projectDirPath);
    expect(calls.map((call) => call.args.slice(0, 2).join(' '))).toEqual([
      'environment list',
      'config plan',
      'variables --skip-deploys',
      'config plan',
      'config apply',
      'up --ci',
    ]);
    const [, firstPlan, variables, secondPlan, apply, up] = calls;
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
    expect(variables?.args).toEqual(
      expect.arrayContaining(['--service=app', '--environment=production', '--set', 'WB_VERSION=v1.2.3'])
    );
    expect(variables?.args).not.toContain('RAILWAY_RUN_UID=0');
    // The first plan is invalidated by the variable sync, so only the re-checked plan may be applied.
    expect(readPlanPath(secondPlan)).not.toBe(readPlanPath(firstPlan));
    expect(apply?.args.slice(2)).toEqual(['--plan', readPlanPath(secondPlan), '--yes']);
    expect(up?.args).toEqual(['up', '--ci', '--project=project-1', '--environment=production', '--service=app']);
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
  planChanges: unknown[],
  env: Record<string, string> = {}
): childProcess.SpawnSyncReturns<string> {
  return childProcess.spawnSync(nodePath!, [binIndexPath, ...args], {
    cwd: projectDirPath,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      FAKE_RAILWAY_PLAN: JSON.stringify({ changeSet: { changes: planChanges }, diagnostics: [] }),
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

export const railwayTarget = { projectId: 'project-1', services: { production: 'app', staging: 'app-staging' } };

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
fs.appendFileSync(${JSON.stringify(path.join(projectDirPath, 'railway-calls.jsonl'))}, JSON.stringify({ args, env: process.env }) + '\\n');
if (args[0] === 'environment') {
  console.log(JSON.stringify({ environments: [{ id: 'env-production', name: 'production' }, { id: 'env-staging', name: 'staging' }] }));
} else if (args[0] === 'variables' && process.env.FAKE_RAILWAY_VARIABLES_FAIL) {
  console.log('SECRET_VALUE_LISTING');
  console.error('railway variables error');
  process.exit(1);
} else if (args[0] === 'config' && args[1] === 'plan') {
  fs.writeFileSync(args[args.indexOf('--out') + 1], process.env.FAKE_RAILWAY_PLAN);
  console.log(process.env.FAKE_RAILWAY_PLAN);
}
`,
    { mode: 0o755 }
  );
}
