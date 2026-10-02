import fs from 'node:fs';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { describe, expect, it } from 'bun:test';

import { buildIfNeeded } from '../../src/commands/buildIfNeeded.js';

import { createTempDir, initializeProjectDirectory } from '../helpers/shared.js';

const tempDir = createTempDir();

describe('buildIfNeeded', () => {
  it('app', async () => {
    const dirPath = path.join(tempDir, 'app');
    await initializeProjectDirectory(dirPath);

    await git(dirPath, 'init');
    await git(dirPath, 'add', '-A');
    await git(dirPath, 'config', 'user.email', 'bot@willbooster.com');
    await git(dirPath, 'config', 'user.name', 'WillBooster Inc.');
    await git(dirPath, 'add', '-A');
    await git(dirPath, 'commit', '-m', '.');

    const command = 'echo build';
    expect(await buildIfNeeded({ command }, dirPath)).toBe(true);
    expect(await buildIfNeeded({ command }, dirPath)).toBe(false);

    await fs.promises.writeFile(path.join(dirPath, 'index.js'), `console.log('Hello'); console.log('Hello');`);
    expect(await buildIfNeeded({ command }, dirPath)).toBe(true);
    expect(await buildIfNeeded({ command }, dirPath)).toBe(false);

    await fs.promises.writeFile(path.join(dirPath, 'README.md'), `# test/fixtures/app/`);
    expect(await buildIfNeeded({ command }, dirPath)).toBe(false);

    await fs.promises.writeFile(
      path.join(dirPath, 'package.json'),
      JSON.stringify(
        {
          name: '@test/fixtures/app2',
        },
        undefined,
        2
      )
    );
    expect(await buildIfNeeded({ command }, dirPath)).toBe(true);
  }, 30_000);

  it('rebuilds when a recorded build output directory is missing', async () => {
    const dirPath = path.join(tempDir, 'outputs', 'app');
    await fs.promises.rm(path.join(tempDir, 'outputs'), { recursive: true, force: true });
    await fs.promises.mkdir(path.join(tempDir, 'outputs'), { recursive: true });
    await initializeProjectDirectory(dirPath);

    await git(dirPath, 'init');
    await git(dirPath, 'config', 'user.email', 'bot@willbooster.com');
    await git(dirPath, 'config', 'user.name', 'WillBooster Inc.');
    await git(dirPath, 'add', '-A');
    await git(dirPath, 'commit', '-m', '.');

    const command = 'mkdir -p dist && echo built > dist/index.txt';
    expect(await buildIfNeeded({ command }, dirPath)).toBe(true);
    expect(await buildIfNeeded({ command }, dirPath)).toBe(false);

    await fs.promises.rm(path.join(dirPath, 'dist'), { recursive: true, force: true });
    expect(await buildIfNeeded({ command }, dirPath)).toBe(true);
    expect(await buildIfNeeded({ command }, dirPath)).toBe(false);
  }, 30_000);
});

async function git(dirPath: string, ...args: string[]): Promise<void> {
  const result = await spawnAsync('git', args, { cwd: dirPath, stdio: 'inherit' });
  expect(result.status).toBe(0);
}
