import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };

const packageDirPath = path.resolve(import.meta.dirname, '..');

test('built cli prints its version', { timeout: 60 * 1000 }, () => {
  buildCli();

  const result = child_process.spawnSync(process.execPath, [path.join(packageDirPath, 'bin', 'wbfy.js'), '--version'], {
    cwd: packageDirPath,
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(packageJson.version);
});

test('packed cli prints its version after npm install', { timeout: 120 * 1000 }, () => {
  buildCli();

  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-packed-cli-'));
  try {
    const packResult = child_process.spawnSync(
      'npm',
      ['pack', packageDirPath, '--json', '--pack-destination', tempDirPath],
      {
        cwd: tempDirPath,
        encoding: 'utf8',
      }
    );
    expect(packResult.stderr).toBe('');
    expect(packResult.status).toBe(0);

    const [{ filename }] = JSON.parse(packResult.stdout) as [{ filename: string }];
    const installResult = child_process.spawnSync(
      'npm',
      ['install', '--ignore-scripts', path.join(tempDirPath, filename)],
      {
        cwd: tempDirPath,
        encoding: 'utf8',
      }
    );
    expect(installResult.stderr).toBe('');
    expect(installResult.status).toBe(0);

    const incompatibleHoistResult = child_process.spawnSync('npm', ['install', '--ignore-scripts', 'libsodium@0.8.3'], {
      cwd: tempDirPath,
      encoding: 'utf8',
    });
    expect(incompatibleHoistResult.stderr).toBe('');
    expect(incompatibleHoistResult.status).toBe(0);

    const result = child_process.spawnSync(path.join(tempDirPath, 'node_modules', '.bin', 'wbfy'), ['--version'], {
      cwd: tempDirPath,
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

function buildCli(): void {
  const buildResult = child_process.spawnSync('yarn', ['build'], {
    cwd: packageDirPath,
    encoding: 'utf8',
  });
  expect(buildResult.status).toBe(0);
}
