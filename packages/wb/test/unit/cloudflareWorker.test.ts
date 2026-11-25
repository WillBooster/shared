import { afterEach, beforeAll, beforeEach, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';

import { buildWb } from '../helpers/build.js';
import { createCloudflareProjectDir } from '../helpers/cloudflareProject.js';

const cliPath = path.resolve('bin/index.js');
const { BUN_TEST_WORKER_ID: _bunWorkerId, JEST_WORKER_ID: _jestWorkerId, ...baseEnv } = process.env;
const workerEnv = { ...baseEnv, AUTH_SECRET: 's3cret', EMPTY_SECRET: '', UNDECLARED_SECRET: 'never-sent' };

let dirPath: string;

beforeAll(buildWb, 120_000);
beforeEach(async () => {
  dirPath = await createWorkerProject();
});
afterEach(async () => {
  await fs.rm(dirPath, { force: true, recursive: true });
});

it('serves a Worker that sees its declared secrets and the D1 schema of its migration settings', async () => {
  const port = await findFreePort();
  const server = spawn('node', [cliPath, 'start'], {
    cwd: dirPath,
    detached: true,
    env: { ...workerEnv, PORT: String(port), WB_ENV: 'development', MISE_ENV: undefined },
    stdio: 'ignore',
  });
  try {
    expect(await fetchJsonWhenReady(`http://127.0.0.1:${port}/`)).toEqual({
      secret: 's3cret',
      tables: ['example', 'migration_history'],
      undeclared: false,
    });
    expect(await fs.readFile(path.join(dirPath, '.dev.vars.development'), 'utf8')).toBe(
      "AUTH_SECRET='s3cret'\nEMPTY_SECRET=''\n"
    );
  } finally {
    if (server.pid) process.kill(-server.pid, 'SIGTERM');
  }
}, 120_000);

it('generates the Worker types that infer the bindings from the config', async () => {
  const result = await spawnAsync('node', [cliPath, 'gen-code'], { cwd: dirPath, env: workerEnv, timeout: 100_000 });

  expect(result.status, result.stdout + result.stderr).toBe(0);
  const types = await fs.readFile(path.join(dirPath, '.cloudflare/types/index.d.ts'), 'utf8');
  // The file is megabytes of runtime types: a failed toContain would print all of it.
  expect(types.includes('typeof import("../../cloudflare.config").default')).toBe(true);
}, 120_000);

it("deploys the build and exactly the declared secrets to the config's account", async () => {
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
      wb: { d1Migrations: { DB: { dir: 'd1', pattern: 'd1/*/migration.sql', table: 'migration_history' } } },
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

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

async function fetchJsonWhenReady(url: string): Promise<unknown> {
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // Not listening yet: the test's timeout bounds the wait.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
