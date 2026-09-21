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
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // A lock left by a killed test run would otherwise block every later run.
    const ownerPid = Number(
      await Bun.file(lockPath)
        .text()
        .catch(() => '')
    );
    if (ownerPid && !isProcessRunning(ownerPid)) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    await Bun.sleep(100);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
