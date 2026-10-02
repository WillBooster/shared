import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SpawnAsyncReturns } from '@willbooster/shared-lib-node/src';
import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { expect, test } from 'bun:test';

const packageDirPath = path.resolve(import.meta.dirname, '..', '..');
const distIndexPath = path.join(packageDirPath, 'dist', 'index.js');

const smallProjectFixtures = [
  { name: 'ESM TypeScript', isEsm: true, sourceFileName: 'index.ts', source: 'export const answer = 42;\n' },
  {
    name: 'CommonJS JavaScript',
    isEsm: false,
    sourceFileName: 'index.cjs',
    source: 'module.exports = { answer: 42 };\n',
  },
];

test.each(smallProjectFixtures)(
  'applying wbfy keeps a small $name project clean after rerunning cleanup',
  async (fixture) => {
    await ensureBuiltCli();

    const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-cleanup-idempotency-'));
    try {
      writeSmallProjectFixture(tempDirPath, fixture);

      await runCommand('git', ['init'], tempDirPath);
      await runCommand('bun', [distIndexPath, tempDirPath], packageDirPath);

      await runCommand('git', ['config', 'user.email', 'agent@willbooster.com'], tempDirPath);
      await runCommand('git', ['config', 'user.name', 'WillBooster Codex'], tempDirPath);
      await runCommand('git', ['add', '-A'], tempDirPath);
      await runCommand('git', ['commit', '--no-verify', '-m', 'test: baseline'], tempDirPath, {
        LEFTHOOK: '0',
      });

      await runCommand('bun', ['run', 'cleanup'], tempDirPath, {
        LEFTHOOK: '0',
      });

      const statusResult = await spawnAsync('git', ['status', '--short'], {
        cwd: tempDirPath,
      });
      expect(statusResult.status).toBe(0);
      expect(statusResult.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(tempDirPath, { force: true, recursive: true });
    }
  },
  300 * 1000
);

async function ensureBuiltCli(): Promise<void> {
  if (isDistUpToDate()) return;

  const buildResult = await spawnAsync('bun', ['run', 'build'], {
    cwd: packageDirPath,
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

  let maxMtimeMs = stat.mtimeMs;
  for (const name of fs.readdirSync(entryPath)) {
    maxMtimeMs = Math.max(maxMtimeMs, getLatestMtimeMs(path.join(entryPath, name)));
  }
  return maxMtimeMs;
}

function writeSmallProjectFixture(dirPath: string, fixture: (typeof smallProjectFixtures)[number]): void {
  fs.mkdirSync(path.join(dirPath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dirPath, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        name: 'small-project',
        ...(fixture.isEsm ? { type: 'module' } : {}),
        description: 'Temporary fixture for wbfy cleanup idempotency tests',
        repository: 'github:example/small-project',
      },
      undefined,
      2
    )}\n`
  );
  fs.writeFileSync(path.join(dirPath, 'README.md'), '# Small Project\n');
  fs.writeFileSync(path.join(dirPath, 'src', fixture.sourceFileName), fixture.source);
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {}
): Promise<SpawnAsyncReturns> {
  const result = await spawnAsync(command, args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  expect(result.status, describeCommandFailure(command, args, cwd, result)).toBe(0);
  return result;
}

function describeCommandFailure(command: string, args: string[], cwd: string, result: SpawnAsyncReturns): string {
  return [
    `command: ${[command, ...args].join(' ')}`,
    `cwd: ${cwd}`,
    `status: ${result.status ?? 'undefined'}`,
    `signal: ${result.signal ?? 'undefined'}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
    describeGeneratedFile(cwd, 'package.json'),
    describeGeneratedFile(cwd, 'bunfig.toml'),
    describeGeneratedFile(cwd, 'mise.toml'),
  ].join('\n\n');
}

function describeGeneratedFile(cwd: string, relativePath: string): string {
  const filePath = path.join(cwd, relativePath);
  if (!fs.existsSync(filePath)) return `${relativePath}: <missing>`;
  return `${relativePath}:\n${fs.readFileSync(filePath, 'utf8')}`;
}
