import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isProcessRunning, wait, waitForProcessStopped } from '../../../test/processUtils.js';
import { spawnAsync } from '../src/spawn.js';
import { treeKill } from '../src/treeKill.js';

describe('spawnAsync killOnExit with SIGTERM', () => {
  const pidsToCleanUp = new Set<number>();

  afterEach(async () => {
    for (const pid of pidsToCleanUp) {
      if (!isProcessRunning(pid)) continue;
      treeKill(pid, 'SIGKILL');
      await waitForProcessStopped(pid, 10_000);
    }
    pidsToCleanUp.clear();
  });

  it('kills child process on parent SIGTERM when killOnExit is enabled', async () => {
    const fixturePath = path.resolve('test-fixtures/spawnAsyncKillOnExitHarness.mjs');
    const pidFilePath = path.join(os.tmpdir(), `spawn-kill-on-exit-${process.pid}-${Date.now()}.pid`);
    try {
      fs.rmSync(pidFilePath, { force: true });
      const harness = spawn(process.execPath, [fixturePath, pidFilePath], {
        stdio: 'ignore',
      });
      expect(harness.pid).toBeDefined();
      if (!harness.pid) {
        throw new Error('harness.pid is undefined');
      }
      pidsToCleanUp.add(harness.pid);

      const childPid = await waitForWrittenPid(pidFilePath, 10_000);
      pidsToCleanUp.add(childPid);
      expect(isProcessRunning(childPid)).toBe(true);

      process.kill(harness.pid, 'SIGTERM');
      await waitForProcessStopped(childPid, 10_000);
      pidsToCleanUp.delete(childPid);
      expect(isProcessRunning(childPid)).toBe(false);

      treeKill(harness.pid, 'SIGKILL');
      await waitForProcessStopped(harness.pid, 10_000);
      pidsToCleanUp.delete(harness.pid);
    } finally {
      fs.rmSync(pidFilePath, { force: true });
    }
  }, 30_000);

  it('registers SIGTERM cleanup for killOnExit', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const removeSpy = vi.spyOn(process, 'removeListener');
    const onCallsStart = onSpy.mock.calls.length;
    const removeCallsStart = removeSpy.mock.calls.length;
    try {
      const command = process.platform === 'win32' ? 'node' : 'sleep';
      const args = process.platform === 'win32' ? ['-e', 'setTimeout(() => {}, 5)'] : ['0.01'];
      await spawnAsync(command, args, { killOnExit: true });

      const registeredEvents = onSpy.mock.calls.slice(onCallsStart).map((args) => args[0]);
      expect(registeredEvents).toContain('beforeExit');
      expect(registeredEvents).toContain('SIGINT');
      expect(registeredEvents).toContain('SIGTERM');
      if (process.platform === 'win32') {
        expect(registeredEvents).not.toContain('SIGQUIT');
      } else {
        expect(registeredEvents).toContain('SIGQUIT');
      }

      const removedEvents = removeSpy.mock.calls.slice(removeCallsStart).map((args) => args[0]);
      expect(removedEvents).toContain('beforeExit');
      expect(removedEvents).toContain('SIGINT');
      expect(removedEvents).toContain('SIGTERM');
      if (process.platform === 'win32') {
        expect(removedEvents).not.toContain('SIGQUIT');
      } else {
        expect(removedEvents).toContain('SIGQUIT');
      }
    } finally {
      onSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('re-sends received signal to self after killOnExit cleanup', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const command = process.platform === 'win32' ? 'node' : 'sleep';
      const args = process.platform === 'win32' ? ['-e', 'setTimeout(() => {}, 20)'] : ['0.02'];
      const promise = spawnAsync(command, args, { killOnExit: true });

      const signalRegistration = [...onSpy.mock.calls].toReversed().find(([event]) => event === 'SIGTERM');
      if (!signalRegistration) {
        throw new Error('SIGTERM handler is not registered');
      }
      const signalHandler = signalRegistration[1];
      if (typeof signalHandler !== 'function') {
        throw new TypeError('SIGTERM handler is not a function');
      }
      signalHandler();
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');

      await promise;
    } finally {
      killSpy.mockRestore();
      onSpy.mockRestore();
    }
  });
});

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
