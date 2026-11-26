import { Database } from 'bun:sqlite';
import { afterEach, beforeAll, beforeEach, expect, it } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';

import { buildWb } from '../helpers/build.js';
import { createCloudflareProjectDir } from '../helpers/cloudflareProject.js';

const cliPath = path.resolve('bin/index.js');
const {
  BUN_TEST_WORKER_ID: _bunWorkerId,
  JEST_WORKER_ID: _jestWorkerId,
  WB_CLOUDFLARE_STATE_DIR: _stateDir,
  ...baseEnv
} = process.env;
const workerEnv = {
  ...baseEnv,
  AUTH_SECRET: 's3cret',
  EMPTY_SECRET: '',
  UNDECLARED_SECRET: 'never-sent',
};

let dirPath: string;

beforeAll(buildWb, 120_000);
beforeEach(async () => {
  dirPath = await createWorkerProject();
});
afterEach(async () => {
  await fs.rm(dirPath, { force: true, recursive: true });
});

it('serves a Worker that sees its declared secrets and the D1 schema of its migration settings', async () => {
  // Without PORT, wb picks a free port itself; with one, it would kill whatever listens there.
  const server = startWb(['start'], { PORT: undefined, NEXT_PUBLIC_BASE_URL: undefined, WB_ENV: 'development' });
  try {
    const response = await fetch(await waitForServerUrl(server));
    expect(await response.json()).toEqual({
      secret: 's3cret',
      tables: ['example', 'migration_history'],
      undeclared: false,
    });
    expect(await fs.readFile(path.join(dirPath, '.dev.vars.development'), 'utf8')).toBe(
      "AUTH_SECRET='s3cret'\nEMPTY_SECRET=''\n"
    );
  } finally {
    stopWb(server);
  }
}, 120_000);

it("serves concurrent test instances on the state directories their callers chose, leaving the mode's own", async () => {
  const sentinelPath = path.join(dirPath, '.cloudflare/state-test/sentinel');
  await fs.mkdir(path.dirname(sentinelPath), { recursive: true });
  await fs.writeFile(sentinelPath, '');
  const instances = await Promise.all(
    ['first', 'second'].map(async (name) => ({
      port: await findFreePort(),
      inspectorPort: await findFreePort(),
      stateDirPath: path.join(dirPath, name),
    }))
  );

  const servers = instances.map(({ inspectorPort, port, stateDirPath }) =>
    startWb(['start', '--mode', 'test', '--', '--inspector-port', String(inspectorPort)], {
      PORT: String(port),
      NEXT_PUBLIC_BASE_URL: undefined,
      WB_ENV: 'test',
      WB_CLOUDFLARE_STATE_DIR: stateDirPath,
    })
  );
  try {
    const bodies = await Promise.all(
      servers.map(async (server, index) => {
        const response = await fetch(await waitForServerUrl(server, instances[index]?.port));
        return response.json();
      })
    );
    expect(bodies).toEqual(
      instances.map(() => ({
        secret: 's3cret',
        tables: ['example', 'migration_history'],
        undeclared: false,
      }))
    );
    expect(await fs.exists(sentinelPath)).toBe(true);
    for (const { stateDirPath } of instances) {
      expect(await fs.exists(path.join(stateDirPath, 'v3/d1/miniflare-D1DatabaseObject'))).toBe(true);
    }
  } finally {
    for (const server of servers) stopWb(server);
  }
}, 120_000);

it("migrates a Drizzle package's cf-native D1 into a chosen state directory with cf, not drizzle-kit", async () => {
  // drizzle-kit is not installed: running it would fail the command.
  const packageJsonPath = path.join(dirPath, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
  await fs.writeFile(packageJsonPath, JSON.stringify({ ...packageJson, dependencies: { 'drizzle-orm': '1.0.0' } }));
  await fs.writeFile(path.join(dirPath, 'drizzle.config.ts'), `export default { dialect: 'sqlite', out: 'd1' };\n`);
  const stateDirPath = path.join(dirPath, 'isolated');

  const result = await spawnAsync('node', [cliPath, 'db', 'migrate'], {
    cwd: dirPath,
    env: { ...workerEnv, WB_ENV: 'test', WB_CLOUDFLARE_STATE_DIR: stateDirPath },
    timeout: 100_000,
  });

  expect(result.status, result.stdout + result.stderr).toBe(0);
  const d1DirPath = path.join(stateDirPath, 'v3/d1/miniflare-D1DatabaseObject');
  const fileNames = await fs.readdir(d1DirPath);
  const databaseFileName = fileNames.find((fileName) => fileName.endsWith('.sqlite') && fileName !== 'metadata.sqlite');
  const database = new Database(path.join(d1DirPath, databaseFileName ?? ''), { readonly: true });
  try {
    expect(
      database
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name"
        )
        .all()
    ).toEqual([{ name: 'example' }, { name: 'migration_history' }]);
  } finally {
    database.close();
  }
  expect(await fs.exists(path.join(dirPath, '.cloudflare/state-test'))).toBe(false);
}, 120_000);

it('generates the Worker types from the config and removes the ones wrangler generated', async () => {
  const staleTypesPath = path.join(dirPath, 'worker-configuration.d.ts');
  await fs.writeFile(staleTypesPath, '/* eslint-disable */\n// Generated by Wrangler by running `wrangler types`\n');

  const result = await spawnAsync('node', [cliPath, 'gen-code'], {
    cwd: dirPath,
    env: workerEnv,
    timeout: 100_000,
  });

  expect(result.status, result.stdout + result.stderr).toBe(0);
  const types = await fs.readFile(path.join(dirPath, '.cloudflare/types/index.d.ts'), 'utf8');
  // The file is megabytes of runtime types: a failed toContain would print all of it.
  expect(types.includes('typeof import("../../cloudflare.config").default')).toBe(true);
  // TypeScript would otherwise keep loading the pre-conversion `Env` beside the generated one.
  expect(await fs.exists(staleTypesPath)).toBe(false);
}, 120_000);

it("deploys the build with the declared secrets and the version to the config's account", async () => {
  const logDirPath = path.join(dirPath, 'cf-log');
  await fs.mkdir(logDirPath);
  await recordAuthenticatedCfCalls();

  const result = await spawnAsync('node', [cliPath, 'deploy'], {
    cwd: dirPath,
    env: {
      ...workerEnv,
      CLOUDFLARE_ACCOUNT_ID: 'shell-account',
      // A deploy on CI requires a token; nothing here contacts Cloudflare.
      CLOUDFLARE_API_TOKEN: 'unused-token',
      WB_ENV: 'staging',
      WB_VERSION: 'v1.2.3',
      WB_TEST_CF_LOG: logDirPath,
    },
    timeout: 100_000,
  });

  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = await fs.readFile(path.join(logDirPath, 'calls'), 'utf8');
  expect(
    calls
      .replace(/--secrets-file \S+/u, '--secrets-file <file>')
      .trim()
      .split('\n')
  ).toEqual([
    'config-account: workers secrets list --mode staging --worker fixture-staging',
    'config-account: deploy --mode staging --prebuilt --dry-run',
    'config-account: d1 migrations apply --mode staging 00000000-0000-4000-8000-000000000001 --dir d1 --pattern d1/*/migration.sql --table migration_history',
    'config-account: deploy --prebuilt --mode staging --secrets-file <file>',
  ]);
  expect(JSON.parse(await fs.readFile(path.join(logDirPath, 'secrets.json'), 'utf8'))).toEqual({
    AUTH_SECRET: 's3cret',
    EMPTY_SECRET: '',
    WB_VERSION: 'v1.2.3',
  });
}, 120_000);

/**
 * A Wrangler-bundled Worker whose toolchain is this package's own: cf requires the bundler in
 * the project's own node_modules, so both are linked instead of installed.
 */
async function createWorkerProject(): Promise<string> {
  const projectDirPath = await createCloudflareProjectDir();
  await fs.writeFile(
    path.join(projectDirPath, 'package.json'),
    JSON.stringify({
      name: 'worker-fixture',
      packageManager: 'bun@1.4.2',
      type: 'module',
      devDependencies: { cf: '1.0.0', wrangler: '4.0.0' },
      wb: {
        d1Migrations: {
          DB: { dir: 'd1', pattern: 'd1/*/migration.sql', table: 'migration_history' },
        },
      },
    })
  );
  await fs.writeFile(
    path.join(projectDirPath, 'cloudflare.config.ts'),
    `import { bindings, defineConfig } from 'cf/config';

export default defineConfig(({ mode = 'development' }) => ({
  accountId: 'config-account',
  worker: {
    name: \`fixture-\${mode}\`,
    entrypoint: './src/index.ts',
    compatibilityDate: '2026-09-01',
    env: {
      WB_ENV: bindings.text(mode),
      AUTH_SECRET: bindings.secret(),
      EMPTY_SECRET: bindings.secret(),
      DB: bindings.d1({ name: 'fixture', id: '00000000-0000-4000-8000-000000000001' }),
    },
  },
}));
`
  );
  await fs.mkdir(path.join(projectDirPath, 'src'));
  await fs.writeFile(
    path.join(projectDirPath, 'src/index.ts'),
    `export default {
  async fetch(_request, env) {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all();
    return Response.json({
      secret: env.AUTH_SECRET,
      tables: results.map((row) => row.name),
      undeclared: 'UNDECLARED_SECRET' in env,
    });
  },
};
`
  );
  const migrationDirPath = path.join(projectDirPath, 'd1/20261126000000_init');
  await fs.mkdir(migrationDirPath, { recursive: true });
  await fs.writeFile(path.join(migrationDirPath, 'migration.sql'), 'CREATE TABLE example (id INTEGER PRIMARY KEY);\n');

  const binDirPath = path.join(projectDirPath, 'node_modules/.bin');
  await fs.mkdir(binDirPath, { recursive: true });
  await fs.symlink(path.resolve('node_modules/wrangler'), path.join(projectDirPath, 'node_modules/wrangler'));
  await fs.symlink(path.resolve('node_modules/.bin/cf'), path.join(binDirPath, 'cf'));
  return projectDirPath;
}

/**
 * Replaces the project's cf with one that runs the real build and records every other call
 * (all of which need a Cloudflare account) with the account it would target.
 */
async function recordAuthenticatedCfCalls(): Promise<void> {
  const cfPath = path.join(dirPath, 'node_modules/.bin/cf');
  await fs.rm(cfPath);
  await fs.writeFile(
    cfPath,
    `#!/bin/sh
if [ "$1" = build ]; then exec "${path.resolve('node_modules/.bin/cf')}" "$@"; fi
printf '%s\\n' "$CLOUDFLARE_ACCOUNT_ID: $*" >> "$WB_TEST_CF_LOG/calls"
for last; do :; done
case "$*" in
  *--secrets-file*) cp "$last" "$WB_TEST_CF_LOG/secrets.json" ;;
  "workers secrets list"*) echo '[]' ;;
esac
`,
    { mode: 0o755 }
  );
}

function startWb(args: string[], env: Record<string, string | undefined>): ChildProcess {
  return spawn('node', [cliPath, ...args], {
    cwd: dirPath,
    detached: true,
    env: { ...workerEnv, MISE_ENV: undefined, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function stopWb(server: ChildProcess): void {
  try {
    if (server.pid) process.kill(-server.pid, 'SIGTERM');
  } catch {
    // The group already exited: keep the startup error instead of this one.
  }
}

const allocatedPorts = new Set<number>();

async function findFreePort(): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    if (!allocatedPorts.has(port)) {
      allocatedPorts.add(port);
      return port;
    }
  }
}

/**
 * Resolves with the URL of the given port, or of the one wb chose (printed in the command it
 * starts), once it responds, and rejects with wb's output when wb exits first.
 */
async function waitForServerUrl(server: ChildProcess, knownPort?: number): Promise<string> {
  let output = '';
  let exitCode: number | null | undefined;
  const onData = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  server.stdout?.on('data', onData);
  server.stderr?.on('data', onData);
  server.once('exit', (code) => {
    exitCode = code;
  });
  for (;;) {
    if (exitCode !== undefined) throw new Error(`wb start exited with ${exitCode} before serving:\n${output}`);
    const port = knownPort ?? /cf dev .*--port (\d+)/u.exec(output)?.[1];
    if (port) {
      const url = `http://127.0.0.1:${port}/`;
      try {
        const response = await fetch(url);
        if (response.ok) return url;
      } catch {
        // Not listening yet: the test's timeout bounds the wait.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
