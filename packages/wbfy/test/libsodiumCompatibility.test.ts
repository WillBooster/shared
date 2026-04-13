import child_process from 'node:child_process';
import path from 'node:path';

import { expect, test } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };

const packageDirPath = path.resolve(import.meta.dirname, '..');

test('built cli prints its version', { timeout: 60 * 1000 }, () => {
  const buildResult = child_process.spawnSync('yarn', ['build'], {
    cwd: packageDirPath,
    encoding: 'utf8',
  });
  expect(buildResult.status).toBe(0);

  const result = child_process.spawnSync(process.execPath, [path.join(packageDirPath, 'bin', 'wbfy.js'), '--version'], {
    cwd: packageDirPath,
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(packageJson.version);
});
