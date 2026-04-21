import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const packageDirPath = path.resolve(import.meta.dirname, '..');
const distIndexPath = path.join(packageDirPath, 'dist', 'index.js');

test('applying wbfy keeps a small yarn project clean after rerunning cleanup', { timeout: 300 * 1000 }, () => {
  ensureBuiltCli();

  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-cleanup-idempotency-'));
  try {
    writeSmallProjectFixture(tempDirPath);

    runCommand('git', ['init'], tempDirPath);
    runCommand('node', [distIndexPath, tempDirPath], packageDirPath);

    runCommand('git', ['config', 'user.email', 'agent@willbooster.com'], tempDirPath);
    runCommand('git', ['config', 'user.name', 'WillBooster Codex'], tempDirPath);
    runCommand('git', ['add', '-A'], tempDirPath);
    runCommand('git', ['commit', '--no-verify', '-m', 'test: baseline'], tempDirPath, {
      HUSKY: '0',
      LEFTHOOK: '0',
    });

    runCommand('yarn', ['cleanup'], tempDirPath, {
      HUSKY: '0',
      LEFTHOOK: '0',
    });

    const statusResult = child_process.spawnSync('git', ['status', '--short'], {
      cwd: tempDirPath,
      encoding: 'utf8',
    });
    expect(statusResult.status).toBe(0);
    expect(statusResult.stdout.trim()).toBe('');
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

function ensureBuiltCli(): void {
  if (isDistUpToDate()) return;

  const buildResult = child_process.spawnSync('yarn', ['build'], {
    cwd: packageDirPath,
    encoding: 'utf8',
  });
  expect(buildResult.status).toBe(0);
}

function isDistUpToDate(): boolean {
  if (!fs.existsSync(distIndexPath)) return false;

  const distMtimeMs = fs.statSync(distIndexPath).mtimeMs;
  for (const relativePath of ['bin/wbfy.js', 'package.json', 'src']) {
    const entryPath = path.join(packageDirPath, relativePath);
    if (getLatestMtimeMs(entryPath) > distMtimeMs) return false;
  }
  return true;
}

function getLatestMtimeMs(entryPath: string): number {
  const stat = fs.statSync(entryPath);
  if (!stat.isDirectory()) return stat.mtimeMs;

  return Math.max(
    stat.mtimeMs, ...fs.readdirSync(entryPath).map((name) => getLatestMtimeMs(path.join(entryPath, name)))
  );
}

function writeSmallProjectFixture(dirPath: string): void {
  fs.mkdirSync(path.join(dirPath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dirPath, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        name: 'small-project',
        type: 'module',
        description: 'Temporary fixture for wbfy cleanup idempotency tests',
        repository: 'github:example/small-project',
      },
      undefined,
      2
    )}\n`
  );
  fs.writeFileSync(path.join(dirPath, 'README.md'), '# Small Project\n');
  fs.writeFileSync(path.join(dirPath, 'src', 'index.ts'), 'export const answer = 42;\n');
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {}
): child_process.SpawnSyncReturns<string> {
  const result = child_process.spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  expect(result.status, [command, ...args].join(' ')).toBe(0);
  return result;
}
