import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SpawnAsyncReturns } from '@willbooster/shared-lib-node/src';
import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { expect, test } from 'bun:test';
import { z } from 'zod';

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
      await runCommand('mise', ['trust', path.join(tempDirPath, 'mise.toml')], tempDirPath);
      await runCommand('bun', [distIndexPath, tempDirPath], packageDirPath);
      const runtime = await runCommand('mise', ['exec', '--', 'bun', '--version'], tempDirPath);
      const tools = z
        .object({ tools: z.object({ bun: z.string() }) })
        .parse(Bun.TOML.parse(fs.readFileSync(path.join(tempDirPath, 'mise.toml'), 'utf8')));
      expect(runtime.stdout.trim()).toBe(tools.tools.bun);

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
      await runCommand('mise', ['untrust', path.join(tempDirPath, 'mise.toml')], tempDirPath);
      fs.rmSync(tempDirPath, { force: true, recursive: true });
    }
  },
  300 * 1000
);

test('rejects a linked mise configuration without modifying the repository or trusting the external file', async () => {
  await ensureBuiltCli();
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-mise-link-'));
  const repoDirPath = path.join(tempDirPath, 'repo');
  const externalPath = path.join(tempDirPath, 'external.toml');
  try {
    fs.mkdirSync(repoDirPath);
    writeSmallProjectFixture(repoDirPath, smallProjectFixtures[0]!);
    fs.renameSync(path.join(repoDirPath, 'mise.toml'), externalPath);
    fs.symlinkSync(externalPath, path.join(repoDirPath, 'mise.toml'));
    await runCommand('git', ['init'], repoDirPath);
    await runCommand('git', ['add', '-A'], repoDirPath);
    await runCommand(
      'git',
      [
        '-c',
        'user.email=agent@willbooster.com',
        '-c',
        'user.name=WillBooster',
        'commit',
        '--no-verify',
        '-m',
        'test: baseline',
      ],
      repoDirPath
    );

    const result = await spawnAsync('bun', [distIndexPath, repoDirPath], {
      cwd: packageDirPath,
      env: { ...process.env, MISE_PARANOID: '1' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('a managed config file is a symlink');
    const after = await runCommand('git', ['status', '--short'], repoDirPath);
    expect(after.stdout.trim()).toBe('');
    expect(fs.readFileSync(externalPath, 'utf8')).toBe('[tools]\nbun = "0.1.0"\n');

    const runtime = await spawnAsync('mise', ['exec', '--', 'bun', '--version'], {
      cwd: repoDirPath,
      env: { ...process.env, MISE_PARANOID: '1' },
    });
    expect(runtime.status).not.toBe(0);
    expect(runtime.stderr).toContain('not trusted');
  } finally {
    await runCommand('mise', ['untrust', externalPath], repoDirPath);
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
}, 300_000);

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
  fs.writeFileSync(path.join(dirPath, 'mise.toml'), '[tools]\nbun = "0.1.0"\n');
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
      MISE_PARANOID: '1',
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
