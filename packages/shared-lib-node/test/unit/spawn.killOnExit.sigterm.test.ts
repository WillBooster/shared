import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isProcessRunning, wait, waitForProcessStopped } from '../../../../test/helpers/processUtils.js';
import { spawnAsync } from '../../src/spawn.js';
import { treeKill } from '../../src/treeKill.js';

const fixturePath = path.resolve('test-fixtures/spawnAsyncKillOnExitHarness.mjs');

describe('spawnAsync killOnExit with a termination signal', () => {
  const pidsToCleanUp = new Set<number>();
  const pidFilePaths = new Set<string>();

  // dist/ is built once for the whole run by the globalSetup in vitest.config.ts.

  afterEach(async () => {
    for (const pid of pidsToCleanUp) {
      if (!isProcessRunning(pid)) continue;
      treeKill(pid, 'SIGKILL');
      await waitForProcessStopped(pid, 10_000);
    }
    pidsToCleanUp.clear();
    for (const pidFilePath of pidFilePaths) {
      fs.rmSync(pidFilePath, { force: true });
    }
    pidFilePaths.clear();
  });

  /** Starts a process that runs a long-lived child through `spawnAsync(..., { killOnExit: true })`. */
  function startHarness(...args: string[]): { harness: ChildProcess & { pid: number }; pidFilePath: string } {
    const pidFilePath = path.join(os.tmpdir(), `spawn-kill-on-exit-${randomUUID()}.pid`);
    pidFilePaths.add(pidFilePath);
    const harness = spawn(process.execPath, [fixturePath, pidFilePath, ...args], { stdio: 'ignore' });
    if (!harness.pid) {
      throw new Error('harness.pid is undefined');
    }
    pidsToCleanUp.add(harness.pid);
    return { harness: harness as ChildProcess & { pid: number }, pidFilePath };
  }

  it.each(['SIGINT', 'SIGTERM', 'SIGQUIT'] as const)(
    'kills the child process on parent %s when killOnExit is enabled',
    async (signal) => {
      const { harness, pidFilePath } = startHarness();

      const childPid = await waitForWrittenPid(pidFilePath, 10_000);
      pidsToCleanUp.add(childPid);
      expect(isProcessRunning(childPid)).toBe(true);

      process.kill(harness.pid, signal);
      await waitForProcessStopped(childPid, 10_000);
      pidsToCleanUp.delete(childPid);
      expect(isProcessRunning(childPid)).toBe(false);
    },
    30_000
  );

  // The handlers are installed on the shared `process` object, so a leak would accumulate across
  // every spawnAsync call of a long-running command such as `wb start`.
  it('leaves no listener behind once the command has exited', async () => {
    const events = ['beforeExit', 'SIGINT', 'SIGTERM', 'SIGQUIT'] as const;
    const listenerCountsBefore = events.map((event) => process.listenerCount(event));

    await spawnAsync('sleep', ['0.01'], { killOnExit: true });

    expect(events.map((event) => process.listenerCount(event))).toEqual(listenerCountsBefore);
  });

  // Re-raising the signal on itself is what lets a parent shell see the real termination reason.
  it('dies from the received signal after cleanup when no other listener remains', async () => {
    const { harness, pidFilePath } = startHarness();
    // The written PID proves the harness finished registering its handlers.
    pidsToCleanUp.add(await waitForWrittenPid(pidFilePath, 10_000));
    const exited = waitForExit(harness);

    process.kill(harness.pid, 'SIGTERM');

    const { code, signal } = await exited;
    expect(signal).toBe('SIGTERM');
    expect(code).toBeUndefined();
  }, 30_000);

  it('lets the application handle the signal when another listener remains', async () => {
    const { harness, pidFilePath } = startHarness('--exit-on-sigterm');
    pidsToCleanUp.add(await waitForWrittenPid(pidFilePath, 10_000));
    const exited = waitForExit(harness);

    process.kill(harness.pid, 'SIGTERM');

    const { code, signal } = await exited;
    expect(code).toBe(0);
    expect(signal).toBeUndefined();
  }, 30_000);
});

function waitForExit(child: ChildProcess): Promise<{ code?: number; signal?: NodeJS.Signals }> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code: code ?? undefined, signal: signal ?? undefined });
    });
  });
}

async function waitForWrittenPid(filePath: string, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const value = fs.readFileSync(filePath, 'utf8').trim();
      if (/^\d+$/.test(value)) {
        return Number.parseInt(value, 10);
      }
    }
    await wait(100);
  }
  throw new Error(`Timed out while waiting PID in ${filePath}`);
}
