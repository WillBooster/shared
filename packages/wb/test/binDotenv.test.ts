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
    // would otherwise silently miss them (https://github.com/WillBooster/shared/issues covered here).
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
