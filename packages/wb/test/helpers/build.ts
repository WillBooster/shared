import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect } from 'bun:test';

/**
 * Builds dist/ for tests that run bin/index.js. Every such test file must call this in `beforeAll`:
 * `bun test --parallel` runs files in concurrent workers, and build-ts deletes dist/ before writing,
 * so an unserialized rebuild breaks another worker's CLI run. The lock serializes the builds, and
 * buildIfNeeded turns every build after the first into a no-op.
 */
export async function buildWb(): Promise<void> {
  // Only workers of one parallel run race each other, so the lock is named after that run's
  // coordinator (the workers' parent), by PID plus start time since a PID alone is reused: a lock left
  // by a force-killed run then never matches a later run. No waiter ever removes a lock, since
  // deciding it is stale and removing it cannot be atomic.
  const lockPath =
    process.env.BUN_TEST_WORKER_ID &&
    path.resolve('node_modules', '.cache', `wb-test-build-${process.ppid}-${readStartTime(process.ppid)}.lock`);
  if (lockPath) await acquireLock(lockPath);
  try {
    // buildIfNeeded hashes the environment, so the per-worker IDs would make every worker rebuild.
    const { BUN_TEST_WORKER_ID: _bunWorkerId, JEST_WORKER_ID: _jestWorkerId, ...env } = process.env;
    const build = spawnSync('bun', ['run', 'build'], { encoding: 'utf8', env, timeout: 60_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
  } finally {
    if (lockPath) fs.rmSync(lockPath, { force: true });
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

function readStartTime(pid: number): string {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().replaceAll(/\W+/g, '-');
}
