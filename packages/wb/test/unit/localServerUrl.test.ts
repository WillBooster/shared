import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import type { Server } from 'node:net';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const binIndexPath = fileURLToPath(new URL('../../bin/index.js', import.meta.url));
const ROOT_PACKAGE_NAME = 'local-server-url-fixture';
const APP_PACKAGE_NAME = '@fixtures/app';
const APP_DIR_NAME = 'packages/app';

let projectDirPath: string;
const servers: Server[] = [];

beforeEach(async () => {
  projectDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-local-server-url-test-'));
  await fs.mkdir(path.join(projectDirPath, '.git'), { recursive: true });
  await writePackage(projectDirPath, ROOT_PACKAGE_NAME);
});

afterEach(async () => {
  await closeServers();
  await fs.rm(projectDirPath, { force: true, recursive: true });
});

async function writePackage(dirPath: string, name: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(path.join(dirPath, 'package.json'), `{ "name": "${name}" }\n`);
  // The script under test only reports what the environment handed it, exactly as a repository's
  // own script (e.g. one importing problems into the running app) would read its endpoint.
  await fs.writeFile(
    path.join(dirPath, 'print-base-url.js'),
    'console.log(JSON.stringify(process.env.NEXT_PUBLIC_BASE_URL ?? null));\n'
  );
}

async function listenOnFreePort(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function closeServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
}

/** Publishes as `wb start` does: at the repository root, named after the serving package. */
async function publishServerUrl(wbEnv: string, packageName: string, baseUrl: string): Promise<string> {
  const filePath = path.join(projectDirPath, '.wb', `server-${wbEnv}-${packageName.replaceAll(/[^\w.-]/g, '-')}.url`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${baseUrl}\n`);
  return filePath;
}

async function publishRunningServerUrl(wbEnv: string, packageName: string): Promise<string> {
  const baseUrl = `http://localhost:${await listenOnFreePort()}`;
  await publishServerUrl(wbEnv, packageName, baseUrl);
  return baseUrl;
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
    const baseUrl = await publishRunningServerUrl('development', ROOT_PACKAGE_NAME);

    expect(runScript()).toBe(JSON.stringify(baseUrl));
  });

  it('reaches a workspace app server from the repository root', async () => {
    // `wb start` serves each descendant project, so the publisher is the package while the
    // consuming script commonly runs at the root.
    await writePackage(path.join(projectDirPath, APP_DIR_NAME), APP_PACKAGE_NAME);
    const baseUrl = await publishRunningServerUrl('development', APP_PACKAGE_NAME);

    expect(runScript()).toBe(JSON.stringify(baseUrl));
  });

  it('reaches the server from a workspace package directory', async () => {
    const appDirPath = path.join(projectDirPath, APP_DIR_NAME);
    await writePackage(appDirPath, APP_PACKAGE_NAME);
    const baseUrl = await publishRunningServerUrl('development', APP_PACKAGE_NAME);

    expect(runScript({}, appDirPath)).toBe(JSON.stringify(baseUrl));
  });

  it('picks its own package server when a monorepo serves several apps', async () => {
    const appDirPath = path.join(projectDirPath, APP_DIR_NAME);
    await writePackage(appDirPath, APP_PACKAGE_NAME);
    const appUrl = await publishRunningServerUrl('development', APP_PACKAGE_NAME);
    await publishRunningServerUrl('development', '@fixtures/admin');

    expect(runScript({}, appDirPath)).toBe(JSON.stringify(appUrl));
    // Ambiguous from the root: naming no package must not silently pick one of the apps.
    expect(runScript()).toBe('null');
  });

  it('reads the environment its own WB_ENV names', async () => {
    const developmentUrl = await publishRunningServerUrl('development', ROOT_PACKAGE_NAME);
    // The e2e server of the same repository listens elsewhere, so its URL must not leak into a
    // development script (nor the reverse).
    await publishServerUrl('test', ROOT_PACKAGE_NAME, 'http://localhost:1');

    expect(runScript()).toBe(JSON.stringify(developmentUrl));
  });

  it('ignores a URL published for a deployed environment', async () => {
    await publishRunningServerUrl('production', ROOT_PACKAGE_NAME);

    expect(runScript({ WB_ENV: 'production' })).toBe('null');
  });

  it('never overrides a configured NEXT_PUBLIC_BASE_URL', async () => {
    await publishRunningServerUrl('development', ROOT_PACKAGE_NAME);

    expect(runScript({ NEXT_PUBLIC_BASE_URL: 'https://configured.example.com' })).toBe(
      JSON.stringify('https://configured.example.com')
    );
  });

  it('keeps a deliberately empty NEXT_PUBLIC_BASE_URL empty', async () => {
    await publishRunningServerUrl('development', ROOT_PACKAGE_NAME);

    expect(runScript({ NEXT_PUBLIC_BASE_URL: '' })).toBe('""');
  });

  it('reports no URL while the published server is not serving yet', async () => {
    // ensurePort publishes while the start command is still being built, so a consumer can run
    // before the port is bound; the publication must survive that for the server's whole life.
    const baseUrl = `http://localhost:${await listenOnFreePort()}`;
    const filePath = await publishServerUrl('development', ROOT_PACKAGE_NAME, baseUrl);
    await closeServers();

    expect(runScript()).toBe('null');
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it('ignores a URL published outside the repository', async () => {
    // A stray .wb in an ancestor (a parent workspace, the home directory, a tmp root) must not
    // answer for a repository that published nothing.
    const baseUrl = `http://localhost:${await listenOnFreePort()}`;
    const ancestorDirPath = path.dirname(projectDirPath);
    const strayFilePath = path.join(ancestorDirPath, '.wb', `server-development-${ROOT_PACKAGE_NAME}.url`);
    await fs.mkdir(path.dirname(strayFilePath), { recursive: true });
    await fs.writeFile(strayFilePath, `${baseUrl}\n`);
    try {
      expect(runScript()).toBe('null');
    } finally {
      await fs.rm(strayFilePath, { force: true });
    }
  });

  it('reports no URL when no server has published one', () => {
    expect(runScript()).toBe('null');
  });
});
