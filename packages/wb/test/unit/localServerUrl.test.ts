import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import type { Server } from 'node:net';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const binIndexPath = fileURLToPath(new URL('../../bin/index.js', import.meta.url));

let projectDirPath: string;
let server: Server | undefined;

beforeEach(async () => {
  projectDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-local-server-url-test-'));
  await fs.mkdir(path.join(projectDirPath, '.git'), { recursive: true });
  await fs.writeFile(path.join(projectDirPath, 'package.json'), '{ "name": "local-server-url-fixture" }\n');
  // The script under test only reports what the environment handed it, exactly as a repository's
  // own script (e.g. one importing problems into the running app) would read its endpoint.
  await fs.writeFile(
    path.join(projectDirPath, 'print-base-url.js'),
    'console.log(process.env.NEXT_PUBLIC_BASE_URL ?? "<undefined>");\n'
  );
});

afterEach(async () => {
  await closeServer();
  await fs.rm(projectDirPath, { force: true, recursive: true });
});

async function listenOnFreePort(): Promise<number> {
  server = createServer();
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function closeServer(): Promise<void> {
  const runningServer = server;
  server = undefined;
  if (runningServer) await new Promise((resolve) => runningServer.close(resolve));
}

async function publishServerUrl(wbEnv: string, baseUrl: string): Promise<string> {
  const filePath = path.join(projectDirPath, '.wb', `server-${wbEnv}.url`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${baseUrl}\n`);
  return filePath;
}

function runScript(env: NodeJS.ProcessEnv = {}, cwd = projectDirPath): string {
  const result = childProcess.spawnSync(process.execPath, [binIndexPath, 'run', 'print-base-url.js'], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, WB_ENV: 'development', ...env },
  });
  expect(result.status).toBe(0);
  // wb reports its env sources first, so only the script's own last line is the answer.
  return result.stdout.trim().split('\n').at(-1) ?? '';
}

describe('wb run', () => {
  it('hands a script the URL of the local server running for this environment', async () => {
    const baseUrl = `http://localhost:${await listenOnFreePort()}`;
    await publishServerUrl('development', baseUrl);

    expect(runScript()).toBe(baseUrl);
  });

  it('finds the URL from a subdirectory of the repository', async () => {
    const baseUrl = `http://localhost:${await listenOnFreePort()}`;
    await publishServerUrl('development', baseUrl);
    const subDirPath = path.join(projectDirPath, 'packages', 'app');
    await fs.mkdir(subDirPath, { recursive: true });
    await fs.copyFile(path.join(projectDirPath, 'print-base-url.js'), path.join(subDirPath, 'print-base-url.js'));

    expect(runScript({}, subDirPath)).toBe(baseUrl);
  });

  it('reads the environment its own WB_ENV names', async () => {
    const developmentUrl = `http://localhost:${await listenOnFreePort()}`;
    await publishServerUrl('development', developmentUrl);
    // The e2e server of the same repository listens elsewhere, so its URL must not leak into a
    // development script (nor the reverse).
    await publishServerUrl('test', 'http://localhost:1');

    expect(runScript()).toBe(developmentUrl);
  });

  it('ignores a URL published for a deployed environment', async () => {
    await publishServerUrl('production', `http://localhost:${await listenOnFreePort()}`);

    expect(runScript({ WB_ENV: 'production' })).toBe('<undefined>');
  });

  it('never overrides a configured NEXT_PUBLIC_BASE_URL', async () => {
    await publishServerUrl('development', `http://localhost:${await listenOnFreePort()}`);

    expect(runScript({ NEXT_PUBLIC_BASE_URL: 'https://configured.example.com' })).toBe(
      'https://configured.example.com'
    );
  });

  it('discards a URL left behind by a crashed server', async () => {
    // A server killed with SIGKILL never runs the exit hook that removes the file, so the file
    // outlives the port it names.
    const filePath = await publishServerUrl('development', `http://localhost:${await listenOnFreePort()}`);
    await closeServer();

    expect(runScript()).toBe('<undefined>');
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('reports no URL when no server has published one', () => {
    expect(runScript()).toBe('<undefined>');
  });
});
