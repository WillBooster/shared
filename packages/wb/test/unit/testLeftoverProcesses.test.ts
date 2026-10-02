import fs from 'node:fs/promises';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { beforeAll, expect, it } from 'bun:test';

import { isProcessRunning, waitForProcessStopped } from '../../../../test/helpers/processUtils.js';
import { buildWb } from '../helpers/build.js';

const cliPath = path.resolve('bin/index.js');

beforeAll(buildWb, 120_000);

it('leaves no process started by a test that timed out', async () => {
  await fs.mkdir('.tmp', { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('.tmp/test-leftover-'));
  let leftoverPid: number | undefined;
  try {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', packageManager: 'bun@1.4.2' })
    );
    await fs.mkdir(path.join(dir, 'test', 'unit'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'test', 'unit', 'timeout.test.ts'),
      `import { test } from 'bun:test';
import { spawn } from 'node:child_process';
test('times out', async () => {
  // A grandchild: bun kills the processes that a timed-out test spawned itself.
  spawn('sh', ['-c', 'sleep 600 & echo $! > pid; wait'], { stdio: 'ignore' });
  await new Promise(() => {});
}, 3000);`
    );

    const { BUN_TEST_WORKER_ID: _bunWorkerId, JEST_WORKER_ID: _jestWorkerId, ...env } = process.env;
    const result = await spawnAsync('node', [cliPath, 'test'], { cwd: dir, env, timeout: 30_000 });
    leftoverPid = Number(await fs.readFile(path.join(dir, 'pid'), 'utf8'));

    expect(result.status, result.stdout + result.stderr).toBe(1);
    await waitForProcessStopped(leftoverPid, 10_000);
  } finally {
    if (leftoverPid && isProcessRunning(leftoverPid)) process.kill(leftoverPid);
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 60_000);
