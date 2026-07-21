import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const binIndexPath = fileURLToPath(new URL('../bin/index.js', import.meta.url));

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
