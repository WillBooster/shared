import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { removeEnvFiles } from '../../src/fixers/envFiles.js';
import { createConfig } from '../helpers/testConfig.js';

test('removes tracked .env cascade files from the index and disk in a fnox repository', async () => {
  await withTempGitRepo(async (tempDirPath) => {
    fs.writeFileSync(path.join(tempDirPath, 'fnox.toml'), '[secrets]\nWB_ENV = { default = "development" }\n');
    fs.writeFileSync(path.join(tempDirPath, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(tempDirPath, '.env.staging'), 'SECRET=2\n');
    fs.mkdirSync(path.join(tempDirPath, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(path.join(tempDirPath, 'apps', 'web', '.env.test'), 'SECRET=3\n');
    fs.writeFileSync(path.join(tempDirPath, '.env.cloudflare'), 'CLOUDFLARE_API_TOKEN=abc\n');
    git(tempDirPath, 'add', '--all', '--force');
    git(tempDirPath, 'commit', '--quiet', '--message', 'add env files');

    await removeEnvFiles(createConfig({ dirPath: tempDirPath, isRoot: true }));

    const tracked = git(tempDirPath, 'ls-files');
    expect(tracked).not.toContain('.env\n');
    expect(tracked).not.toContain('.env.staging');
    expect(tracked).not.toContain('apps/web/.env.test');
    expect(fs.existsSync(path.join(tempDirPath, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(tempDirPath, '.env.staging'))).toBe(false);
    expect(fs.existsSync(path.join(tempDirPath, 'apps', 'web', '.env.test'))).toBe(false);
    // The deployment-credential sidecar stays tracked and on disk.
    expect(tracked).toContain('.env.cloudflare');
    expect(fs.existsSync(path.join(tempDirPath, '.env.cloudflare'))).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

test('is a no-op when no tracked .env files exist', async () => {
  await withTempGitRepo(async (tempDirPath) => {
    fs.writeFileSync(path.join(tempDirPath, 'fnox.toml'), '[secrets]\n');
    // An UNTRACKED .env must survive: only committed files are the security problem.
    fs.writeFileSync(path.join(tempDirPath, '.env'), 'SECRET=1\n');
    git(tempDirPath, 'add', 'fnox.toml');
    git(tempDirPath, 'commit', '--quiet', '--message', 'add fnox.toml');

    await removeEnvFiles(createConfig({ dirPath: tempDirPath, isRoot: true }));

    expect(fs.existsSync(path.join(tempDirPath, '.env'))).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

test('leaves non-fnox repositories untouched', async () => {
  await withTempGitRepo(async (tempDirPath) => {
    fs.writeFileSync(path.join(tempDirPath, '.env'), 'SECRET=1\n');
    git(tempDirPath, 'add', '--all', '--force');
    git(tempDirPath, 'commit', '--quiet', '--message', 'add .env');

    await removeEnvFiles(createConfig({ dirPath: tempDirPath, isRoot: true }));

    expect(git(tempDirPath, 'ls-files')).toContain('.env');
    expect(fs.readFileSync(path.join(tempDirPath, '.env'), 'utf8')).toBe('SECRET=1\n');
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function withTempGitRepo(testBody: (tempDirPath: string) => Promise<void>): Promise<void> {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-env-files-')));
  const originalExitCode = process.exitCode;
  try {
    git(tempDirPath, 'init', '--quiet');
    git(tempDirPath, 'config', 'user.email', 'test@example.com');
    git(tempDirPath, 'config', 'user.name', 'Test');
    await testBody(tempDirPath);
  } finally {
    process.exitCode = originalExitCode;
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
}
