import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect } from 'bun:test';

const lockPath = path.resolve('node_modules', '.cache', 'wb-test-build.lock');

/**
 * Builds dist/ for tests that run bin/index.js. Every such test file must call this in `beforeAll`:
 * `bun test --parallel` runs files in concurrent workers, and build-ts deletes dist/ before writing,
 * so an unserialized rebuild breaks another worker's CLI run. The lock serializes the builds, and
 * buildIfNeeded turns every build after the first into a no-op.
 */
export async function buildWb(): Promise<void> {
  await acquireLock();
  try {
    // buildIfNeeded hashes the environment, so the per-worker IDs would make every worker rebuild.
    const { BUN_TEST_WORKER_ID: _bunWorkerId, JEST_WORKER_ID: _jestWorkerId, ...env } = process.env;
    const build = spawnSync('bun', ['run', 'build'], { encoding: 'utf8', env, timeout: 60_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

async function acquireLock(): Promise<void> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // Waiters never remove the lock: a stale-lock takeover cannot be made atomic, so two waiters could
  // both take over and build concurrently. A build takes seconds, so a lock held this long is one
  // left by a killed test run.
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, '', { flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (Date.now() > deadline) {
      throw new Error(`${lockPath} is still locked; delete it if no other test run is building wb.`);
    }
    await Bun.sleep(100);
  }
}
