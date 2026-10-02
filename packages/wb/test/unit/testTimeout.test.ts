import fs from 'node:fs/promises';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { afterAll, beforeAll, expect, it } from 'bun:test';

import { buildWb } from '../helpers/build.js';

const fileCount = 3;
let dir: string;

beforeAll(async () => {
  await buildWb();
  await fs.mkdir('.tmp', { recursive: true });
  dir = await fs.mkdtemp(path.resolve('.tmp/test-timeout-'));
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'timeout-fixture', packageManager: 'bun@1.4.2' })
  );
  // A timeout shorter than Bun's default shows that it is applied without waiting past that default.
  await fs.writeFile(path.join(dir, 'bunfig.toml'), '[test]\ntimeout = 200\n');
  await fs.mkdir(path.join(dir, 'test/unit'), { recursive: true });
  for (let index = 0; index < fileCount; index++) {
    await fs.writeFile(
      path.join(dir, `test/unit/slow${index}.test.ts`),
      "import { test } from 'bun:test'; test('slow case', () => Bun.sleep(2000));"
    );
  }
}, 120_000);
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

it('applies the `[test] timeout` of bunfig.toml to every unit test file', async () => {
  const { BUN_TEST_WORKER_ID: _bunWorkerId, JEST_WORKER_ID: _jestWorkerId, ...env } = process.env;
  const result = await spawnAsync('node', [path.resolve('bin/index.js'), 'test'], { cwd: dir, env, timeout: 30_000 });
  const output = result.stdout + result.stderr;
  expect(result.status, output).not.toBe(0);
  expect(output.match(/timed out after 200ms/g), output).toHaveLength(fileCount);
}, 60_000);
