import fs from 'node:fs';
import type { Server } from 'node:net';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../src/project.js';
import { applyLocalServerUrl, publishLocalServerUrl, readLocalServerUrl } from '../../src/utils/localServerUrl.js';

const servers: Server[] = [];
const dirPaths: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const dirPath of dirPaths.splice(0)) fs.rmSync(dirPath, { force: true, recursive: true });
});

function createProjectDirPath(): string {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-local-server-url-'));
  dirPaths.push(dirPath);
  return dirPath;
}

function createFakeProject(dirPath: string, wbEnv: string | undefined): Project {
  return { dirPath, env: { WB_ENV: wbEnv } } as unknown as Project;
}

async function listenOnFreePort(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

describe('publishLocalServerUrl', () => {
  it('publishes the bare URL of a running server and reads it back from a subdirectory', async () => {
    const dirPath = createProjectDirPath();
    const baseUrl = `http://localhost:${await listenOnFreePort()}`;
    publishLocalServerUrl(createFakeProject(dirPath, 'development'), baseUrl);

    expect(fs.readFileSync(path.join(dirPath, '.wb', 'server-development.url'), 'utf8')).toBe(`${baseUrl}\n`);
    const subDirPath = path.join(dirPath, 'packages', 'app');
    fs.mkdirSync(subDirPath, { recursive: true });
    await expect(readLocalServerUrl(subDirPath, 'development')).resolves.toBe(baseUrl);
  });

  it('keeps a development server and an e2e run of the same repository apart', async () => {
    const dirPath = createProjectDirPath();
    const developmentUrl = `http://localhost:${await listenOnFreePort()}`;
    const testUrl = `http://localhost:${await listenOnFreePort()}`;
    publishLocalServerUrl(createFakeProject(dirPath, 'development'), developmentUrl);
    publishLocalServerUrl(createFakeProject(dirPath, 'test'), testUrl);

    await expect(readLocalServerUrl(dirPath, 'development')).resolves.toBe(developmentUrl);
    await expect(readLocalServerUrl(dirPath, 'test')).resolves.toBe(testUrl);
  });

  it('publishes nothing for a deployed environment, which carries a fixed URL', async () => {
    const dirPath = createProjectDirPath();
    publishLocalServerUrl(createFakeProject(dirPath, 'production'), 'https://example.com');

    expect(fs.existsSync(path.join(dirPath, '.wb'))).toBe(false);
    await expect(readLocalServerUrl(dirPath, 'production')).resolves.toBeUndefined();
  });
});

describe('readLocalServerUrl', () => {
  it('discards a file left behind by a crashed server', async () => {
    const dirPath = createProjectDirPath();
    // Publishing while the port is listening, then closing it, reproduces a crash: the process
    // died without the 'exit' event that removes the file.
    const port = await listenOnFreePort();
    publishLocalServerUrl(createFakeProject(dirPath, 'development'), `http://localhost:${port}`);
    await new Promise((resolve) => servers.pop()?.close(resolve));

    await expect(readLocalServerUrl(dirPath, 'development')).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dirPath, '.wb', 'server-development.url'))).toBe(false);
  });

  it('returns undefined without a published file', async () => {
    await expect(readLocalServerUrl(createProjectDirPath(), 'development')).resolves.toBeUndefined();
  });
});

describe('applyLocalServerUrl', () => {
  it('exposes the running server URL as NEXT_PUBLIC_BASE_URL', async () => {
    const dirPath = createProjectDirPath();
    const baseUrl = `http://localhost:${await listenOnFreePort()}`;
    publishLocalServerUrl(createFakeProject(dirPath, 'development'), baseUrl);

    const env: NodeJS.ProcessEnv = { WB_ENV: 'development' };
    await applyLocalServerUrl(dirPath, env);
    expect(env.NEXT_PUBLIC_BASE_URL).toBe(baseUrl);
  });

  it('never overrides a configured NEXT_PUBLIC_BASE_URL', async () => {
    const dirPath = createProjectDirPath();
    publishLocalServerUrl(createFakeProject(dirPath, 'development'), `http://localhost:${await listenOnFreePort()}`);

    const env: NodeJS.ProcessEnv = { WB_ENV: 'development', NEXT_PUBLIC_BASE_URL: 'http://localhost:3000' };
    await applyLocalServerUrl(dirPath, env);
    expect(env.NEXT_PUBLIC_BASE_URL).toBe('http://localhost:3000');
  });
});
