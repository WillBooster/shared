import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const binIndexPath = fileURLToPath(new URL('../bin/index.js', import.meta.url));
const sourceIndexPath = fileURLToPath(new URL('../src/index.ts', import.meta.url));

function isFnoxAvailable(): boolean {
  return childProcess.spawnSync('fnox', ['--version'], { stdio: 'ignore' }).status === 0;
}

describe('bin/index.js dotenv fast path', () => {
  let projectDirPath: string;

  beforeEach(async () => {
    projectDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-bin-dotenv-test-'));
  });

  afterEach(async () => {
    await fs.rm(projectDirPath, { force: true, recursive: true });
  });

  it('resolves bare binary names from node_modules/.bin after stripping the yarn environment', async () => {
    // The released `wb dotenv` routes through bin/dotenv.js (not dist), so this must be
    // exercised through bin/index.js: helper unit tests cannot catch drift between the
    // TypeScript implementation and this startup fast path.
    await fs.mkdir(path.join(projectDirPath, '.git'), { recursive: true });
    const binDirPath = path.join(projectDirPath, 'node_modules', '.bin');
    await fs.mkdir(binDirPath, { recursive: true });
    const probePath = path.join(binDirPath, 'review-probe');
    await fs.writeFile(probePath, '#!/bin/sh\necho probe-ok\n', { mode: 0o755 });

    const result = childProcess.spawnSync(process.execPath, [binIndexPath, 'dotenv', '--', 'review-probe'], {
      cwd: projectDirPath,
      encoding: 'utf8',
      // A yarn-like environment: the temporary bin folder is the only PATH entry yarn adds,
      // and wb dotenv strips it before spawning.
      env: { PATH: '/usr/bin:/bin', BERRY_BIN_FOLDER: '/tmp/xfs-fake' },
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('probe-ok\n');
    expect(result.status).toBe(0);
  });

  it.runIf(isFnoxAvailable())('loads fnox-provided environment variables preferring .env files', async () => {
    // The released `wb dotenv` routes through bin/dotenv.js (not dist), so fnox loading must be
    // exercised through bin/index.js to catch drift from the TypeScript implementation.
    await fs.mkdir(path.join(projectDirPath, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(projectDirPath, 'fnox.toml'),
      '[secrets]\nENV = { default = "fnox-value" }\nFNOX_ONLY = { default = "fnox-only" }\n'
    );
    await fs.writeFile(path.join(projectDirPath, '.env'), 'ENV=dotenv-value\n');

    const result = childProcess.spawnSync(
      process.execPath,
      [binIndexPath, 'dotenv', '--', 'sh', '-c', 'echo "$ENV" "$FNOX_ONLY"'],
      {
        cwd: projectDirPath,
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      }
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('dotenv-value fnox-only\n');
    expect(result.status).toBe(0);
  });

  it.runIf(isFnoxAvailable())('loads development-profile fnox secrets when WB_ENV is unset', async () => {
    // An unset WB_ENV must select the development profile (like wb's main loader), not the base
    // `[secrets]` table alone: a repo keeping dev-only secrets in `[profiles.development.secrets]`
    // would otherwise silently miss them.
    await fs.mkdir(path.join(projectDirPath, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(projectDirPath, 'fnox.toml'),
      '[secrets]\nBASE_ONLY = { default = "base-value" }\n\n[profiles.development.secrets]\nDEV_ONLY = { default = "dev-value" }\n'
    );

    const result = childProcess.spawnSync(
      process.execPath,
      [binIndexPath, 'dotenv', '--', 'sh', '-c', 'echo "$BASE_ONLY" "$DEV_ONLY"'],
      {
        cwd: projectDirPath,
        encoding: 'utf8',
        // A clean env (only PATH) leaves WB_ENV and NODE_ENV unset, so the cascade defaults to development.
        env: { PATH: process.env.PATH },
      }
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('base-value dev-value\n');
    expect(result.status).toBe(0);
  });

  it.runIf(isFnoxAvailable())('honors an explicit FNOX_PROFILE when WB_ENV is unset', async () => {
    // Defaulting to development must not override an explicitly selected FNOX_PROFILE: fnox honors it,
    // so `wb dotenv` without WB_ENV must too (the profile still folds into the `--profile` it passes).
    await fs.mkdir(path.join(projectDirPath, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(projectDirPath, 'fnox.toml'),
      '[secrets]\nSELECTED = { default = "base" }\n\n[profiles.development.secrets]\nSELECTED = { default = "development" }\n\n[profiles.test.secrets]\nSELECTED = { default = "test" }\n'
    );

    const result = childProcess.spawnSync(
      process.execPath,
      [binIndexPath, 'dotenv', '--', 'sh', '-c', 'echo "$SELECTED"'],
      {
        cwd: projectDirPath,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, FNOX_PROFILE: 'test' },
      }
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('test\n');
    expect(result.status).toBe(0);
  });

  it('rejects an env source whose WB_ENV disagrees with the default development cascade', async () => {
    // `.env.development` is read even when WB_ENV is unset (cascade defaults to development); a WB_ENV
    // it defines that disagrees with that cascade would run the child labeled one environment while
    // carrying another's secrets, so it must fail fast (matching the forced-mode mismatch guard).
    await fs.mkdir(path.join(projectDirPath, '.git'), { recursive: true });
    await fs.writeFile(path.join(projectDirPath, '.env.development'), 'WB_ENV=production\n');

    const result = childProcess.spawnSync(
      process.execPath,
      [binIndexPath, 'dotenv', '--', 'sh', '-c', 'echo should-not-run'],
      {
        cwd: projectDirPath,
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      }
    );
    expect(result.stdout).not.toContain('should-not-run');
    expect(result.stderr).toContain('WB_ENV resolves to "production"');
    expect(result.status).toBe(1);
  });

  it('allows a non-standard cascade suffix (NODE_ENV=qa) to carry a standard WB_ENV', async () => {
    // `NODE_ENV=qa` selects `.env.qa` while WB_ENV stays a standard mode — a supported cascade the
    // mismatch guard must not reject (it enforces only standard cascades, like the main loader).
    await fs.mkdir(path.join(projectDirPath, '.git'), { recursive: true });
    await fs.writeFile(path.join(projectDirPath, '.env.qa'), 'WB_ENV=development\nSELECTED=qa-file\n');

    const result = childProcess.spawnSync(
      process.execPath,
      [binIndexPath, 'dotenv', '--', 'sh', '-c', 'echo "$WB_ENV" "$SELECTED"'],
      {
        cwd: projectDirPath,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, NODE_ENV: 'qa' },
      }
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('development qa-file\n');
    expect(result.status).toBe(0);
  });

  it('does not let FNOX_PROFILE redirect the .env cascade or the WB_ENV check without fnox.toml', async () => {
    // FNOX_PROFILE is a fnox-only selector; in a legacy `.env`-only project it must NOT choose which
    // `.env.<x>` files load (that stays `WB_ENV || NODE_ENV || development`) NOR the environment the
    // WB_ENV mismatch guard expects — here `.env.test` correctly resolves WB_ENV=test even though
    // FNOX_PROFILE names production.
    await fs.mkdir(path.join(projectDirPath, '.git'), { recursive: true });
    await fs.writeFile(path.join(projectDirPath, '.env.test'), 'WB_ENV=test\nSELECTED=test\n');
    await fs.writeFile(path.join(projectDirPath, '.env.production'), 'WB_ENV=production\nSELECTED=production\n');

    const result = childProcess.spawnSync(
      process.execPath,
      [binIndexPath, 'dotenv', '--', 'sh', '-c', 'echo "$WB_ENV" "$SELECTED"'],
      {
        cwd: projectDirPath,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, NODE_ENV: 'test', FNOX_PROFILE: 'production' },
      }
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('test test\n');
    expect(result.status).toBe(0);
  });

  it("restores yarn's temporary bin folder for Plug'n'Play projects without node_modules", async () => {
    // PnP installs create no node_modules/.bin, so the (otherwise stripped) BERRY_BIN_FOLDER
    // is the only source of dependency executables and must be restored.
    await fs.mkdir(path.join(projectDirPath, '.git'), { recursive: true });
    const berryBinDirPath = path.join(projectDirPath, 'berry-bin');
    await fs.mkdir(berryBinDirPath, { recursive: true });
    await fs.writeFile(path.join(berryBinDirPath, 'review-probe'), '#!/bin/sh\necho pnp-ok\n', { mode: 0o755 });

    const result = childProcess.spawnSync(process.execPath, [binIndexPath, 'dotenv', '--', 'review-probe'], {
      cwd: projectDirPath,
      encoding: 'utf8',
      env: { PATH: `${berryBinDirPath}:/usr/bin:/bin`, BERRY_BIN_FOLDER: berryBinDirPath },
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('pnp-ok\n');
    expect(result.status).toBe(0);
  });
});

describe('bin/index.js run fast path', () => {
  let projectDirPath: string;

  beforeEach(async () => {
    projectDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-bin-run-test-'));
    await fs.mkdir(path.join(projectDirPath, '.git'));
  });

  afterEach(async () => {
    await fs.rm(projectDirPath, { force: true, recursive: true });
  });

  it('runs TypeScript with Node and forwards environment variables and arguments', async () => {
    await fs.writeFile(path.join(projectDirPath, '.env'), 'LOADED_BY_WB=from-dotenv\n');
    await fs.writeFile(
      path.join(projectDirPath, 'probe.ts'),
      "const value: string = `${process.env.LOADED_BY_WB}:${process.argv.slice(2).join(',')}`;\nconsole.log(value);\n"
    );

    const result = childProcess.spawnSync(
      process.execPath,
      [binIndexPath, 'run', 'probe.ts', 'first', '--', '--second'],
      {
        cwd: projectDirPath,
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      }
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('from-dotenv:first,--second\n');
    expect(result.status).toBe(0);
  });

  it('honors environment-selection options through the full CLI path', async () => {
    await fs.writeFile(path.join(projectDirPath, 'custom.env'), 'LOADED_BY_WB=custom\n');
    await fs.writeFile(path.join(projectDirPath, 'probe.js'), 'console.log(process.env.LOADED_BY_WB);\n');

    const result = childProcess.spawnSync(
      'bun',
      [sourceIndexPath, '--working-dir', projectDirPath, '--env', 'custom.env', 'run', 'probe.js'],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      }
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('custom\n');
    expect(result.status).toBe(0);
  });

  it('preserves shutdown signals through the full CLI path', async () => {
    await fs.writeFile(path.join(projectDirPath, 'wait.js'), "console.log('ready');\nsetInterval(() => {}, 1_000);\n");

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = childProcess.spawn(
        'bun',
        [sourceIndexPath, '--working-dir', projectDirPath, '--quiet-env', 'run', 'wait.js'],
        {
          env: { PATH: process.env.PATH },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Timed out waiting for the run child process'));
      }, 5000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (output: string) => {
        if (output.includes('ready')) child.kill('SIGINT');
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    expect(result.code).toBeNull();
    expect(result.signal).toBe('SIGINT');
  });

  it('runs package scripts with Bun in Bun projects', async () => {
    await fs.writeFile(
      path.join(projectDirPath, 'package.json'),
      JSON.stringify({ packageManager: 'bun@1.3.14', scripts: { probe: 'node probe.js' } })
    );
    await fs.writeFile(
      path.join(projectDirPath, 'probe.js'),
      "console.log(`bun-script:${process.argv.slice(2).join(',')}`);\n"
    );

    const result = childProcess.spawnSync(process.execPath, [binIndexPath, 'run', 'probe', 'argument'], {
      cwd: projectDirPath,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(result.stderr).toContain('$ node probe.js argument');
    expect(result.stdout).toBe('bun-script:argument\n');
    expect(result.status).toBe(0);
  });

  it('prints usage instead of starting a runtime without a script', () => {
    const result = childProcess.spawnSync(process.execPath, [binIndexPath, 'run'], {
      cwd: projectDirPath,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Usage: wb run <script> [args...]\n');
    expect(result.status).toBe(1);
  });
});
