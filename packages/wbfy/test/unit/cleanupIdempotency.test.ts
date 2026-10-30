import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SpawnAsyncReturns } from '@willbooster/shared-lib-node/src';
import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { z } from 'zod';

const packageDirPath = path.resolve(import.meta.dirname, '..', '..');
const distIndexPath = path.join(packageDirPath, 'dist', 'index.js');
const localWbDirPath = path.resolve(packageDirPath, '..', 'wb');

const smallProjectFixtures = [
  {
    name: 'ESM TypeScript',
    isEsm: true,
    sourceFileName: 'index.ts',
    source:
      "import { format } from 'oxfmt';\nconst result = await format('example.js', 'const answer=42');\nconsole.log(result.code);\n",
  },
  {
    name: 'CommonJS JavaScript',
    isEsm: false,
    sourceFileName: 'index.cjs',
    source: 'module.exports = { answer: 42 };\n',
  },
];

test.each(['bun', 'node'].flatMap((runtime) => smallProjectFixtures.map((fixture) => ({ ...fixture, runtime }))))(
  'applying wbfy under $runtime keeps a small $name project clean after rerunning cleanup',
  async (fixture) => {
    await ensureBuiltCli();

    const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-cleanup-idempotency-'));
    try {
      writeSmallProjectFixture(tempDirPath, fixture);

      await runCommand('git', ['init'], tempDirPath);
      await runCommand('mise', ['trust', path.join(tempDirPath, 'mise.toml')], tempDirPath);
      const callerBinDirPath = path.join(tempDirPath, '.tmp', 'caller-bin');
      fs.mkdirSync(callerBinDirPath, { recursive: true });
      const callerNode = await runCommand('node', ['-p', 'process.execPath'], packageDirPath);
      const installedNodePath = callerNode.stdout.trim();
      fs.copyFileSync(installedNodePath, path.join(callerBinDirPath, 'node'), fs.constants.COPYFILE_FICLONE);
      fs.symlinkSync(path.resolve(path.dirname(installedNodePath), '../lib'), path.join(callerBinDirPath, '../lib'));
      const applied = await runCommand(
        fixture.runtime,
        [path.join(packageDirPath, 'bin/wbfy.js'), tempDirPath],
        packageDirPath,
        { PATH: `${callerBinDirPath}${path.delimiter}${process.env.PATH}` }
      );
      expect(applied.stdout + applied.stderr).not.toContain('Error occurred');
      expect(fs.existsSync(path.join(tempDirPath, 'oxfmt.config.ts'))).toBe(false);
      if (fixture.isEsm) {
        const formatted = await runCommand('bun', ['src/index.ts'], tempDirPath);
        expect(formatted.stdout.trim()).toBe('const answer = 42;');
      }
      const runtime = await runCommand('mise', ['exec', '--', 'bun', '--version'], tempDirPath);
      const tools = z
        .object({ tools: z.object({ bun: z.string(), node: z.string() }) })
        .parse(Bun.TOML.parse(fs.readFileSync(path.join(tempDirPath, 'mise.toml'), 'utf8')));
      expect(runtime.stdout.trim()).toBe(tools.tools.bun);
      const pinnedNode = await runCommand('mise', ['which', 'node'], tempDirPath);
      const installedWithNode = fs.readFileSync(path.join(tempDirPath, 'node-exec-path.txt'), 'utf8').trim();
      expect(fs.realpathSync(installedWithNode)).toBe(fs.realpathSync(pinnedNode.stdout.trim()));

      await runCommand('git', ['config', 'user.email', 'agent@willbooster.com'], tempDirPath);
      await runCommand('git', ['config', 'user.name', 'WillBooster Codex'], tempDirPath);
      await runCommand('git', ['add', '-A'], tempDirPath);
      await runCommand('git', ['commit', '--no-verify', '-m', 'test: baseline'], tempDirPath, {
        LEFTHOOK: '0',
      });

      // Check this wbfy against this repository's wb, not the published one, which may still run
      // tools that this wbfy has removed.
      await ensureBuiltCli(localWbDirPath);
      linkLocalWb(tempDirPath);
      await runCommand('bun', ['run', 'cleanup'], tempDirPath, {
        LEFTHOOK: '0',
      });

      const statusResult = await spawnAsync('git', ['status', '--short'], {
        cwd: tempDirPath,
      });
      expect(statusResult.status).toBe(0);
      expect(statusResult.stdout.trim()).toBe('');
    } finally {
      await removeFixture(tempDirPath, path.join(tempDirPath, 'mise.toml'));
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
    expect(fs.readFileSync(externalPath, 'utf8')).toBe('[tools]\nnode = "24"\nbun = "0.1.0"\n');

    const runtime = await spawnAsync('mise', ['exec', '--', 'bun', '--version'], {
      cwd: repoDirPath,
      env: { ...process.env, MISE_PARANOID: '1' },
    });
    expect(runtime.status).not.toBe(0);
    expect(runtime.stderr).toContain('not trusted');
  } finally {
    await removeFixture(tempDirPath, externalPath);
  }
}, 300_000);

function linkLocalWb(dirPath: string): void {
  const installedWbPath = path.join(dirPath, 'node_modules', '@willbooster', 'wb');
  fs.rmSync(installedWbPath, { force: true, recursive: true });
  fs.symlinkSync(localWbDirPath, installedWbPath);
}

async function removeFixture(dirPath: string, miseTomlPath: string): Promise<void> {
  // Cleanup must preserve the test failure even if mise cannot launch.
  await spawnAsync('mise', ['untrust', miseTomlPath], {
    cwd: packageDirPath,
    env: { ...process.env, MISE_PARANOID: '1' },
  }).catch(() => {});
  fs.rmSync(dirPath, { force: true, recursive: true });
}

async function ensureBuiltCli(dirPath = packageDirPath): Promise<void> {
  if (isDistUpToDate(dirPath)) return;

  const buildResult = await spawnAsync('bun', ['run', 'build'], {
    cwd: dirPath,
  });
  expect(buildResult.status).toBe(0);
}

function isDistUpToDate(dirPath: string): boolean {
  const distPath = path.join(dirPath, 'dist', 'index.js');
  if (!fs.existsSync(distPath)) return false;

  const distMtimeMs = fs.statSync(distPath).mtimeMs;
  for (const relativePath of ['bin', 'package.json', 'src']) {
    const entryPath = path.join(dirPath, relativePath);
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
        scripts: { postinstall: 'node -p process.execPath > node-exec-path.txt' },
        ...(fixture.isEsm ? { dependencies: { oxfmt: '0.73.0' } } : {}),
        devDependencies: { '@willbooster/oxfmt-config': '1.2.2' },
      },
      undefined,
      2
    )}\n`
  );
  fs.writeFileSync(path.join(dirPath, 'README.md'), '# Small Project\n');
  fs.writeFileSync(
    path.join(dirPath, 'oxfmt.config.ts'),
    "import config from '@willbooster/oxfmt-config';\nexport default config;\n"
  );
  fs.writeFileSync(path.join(dirPath, 'mise.toml'), '[tools]\nnode = "24"\nbun = "0.1.0"\n');
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
