import fs from 'node:fs';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { expect } from 'bun:test';

/**
 * Builds dist/ for tests that run bin/index.js. Every such test file must call this in `beforeAll`:
 * `bun test --parallel` runs files in concurrent workers, and build-ts deletes dist/ before writing,
 * so a rebuild breaks another worker's CLI run. The lock serializes the workers, and only the first
 * of a run builds, so later files skip spawning the build.
 */
export async function buildWb(): Promise<void> {
  // Only workers of one parallel run race each other, so the lock is named after that run's
  // coordinator (the workers' parent), by PID plus start time since a PID alone is reused: a lock left
  // by a force-killed run then never matches a later run. No waiter ever removes a lock, since
  // deciding it is stale and removing it cannot be atomic.
  const runPathPrefix =
    process.env.BUN_TEST_WORKER_ID &&
    path.resolve('node_modules', '.cache', `wb-test-build-${process.ppid}-${await readStartTime(process.ppid)}`);
  if (runPathPrefix) await acquireLock(`${runPathPrefix}.lock`);
  try {
    if (runPathPrefix && fs.existsSync(`${runPathPrefix}.built`)) return;
    // Leaves out the worker ID: buildIfNeeded hashes the environment, so keeping it would record a cache
    // that the next run misses whenever a different worker builds first.
    const { BUN_TEST_WORKER_ID: _bunWorkerId, JEST_WORKER_ID: _jestWorkerId, ...env } = process.env;
    const build = await spawnAsync('bun', ['run', 'build'], { env, timeout: 60_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    if (runPathPrefix) fs.writeFileSync(`${runPathPrefix}.built`, '');
  } finally {
    if (runPathPrefix) fs.rmSync(`${runPathPrefix}.lock`, { force: true });
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // The holder can only be a worker of this run; one that died while building fails this run alone.
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, '', { flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for another test worker to build wb (${lockPath}).`);
    await Bun.sleep(100);
  }
}

async function readStartTime(pid: number): Promise<string> {
  const result = await spawnAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().replaceAll(/\W+/g, '-');
}
