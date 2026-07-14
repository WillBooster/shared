import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const binIndexPath = fileURLToPath(new URL('../bin/index.js', import.meta.url));

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
