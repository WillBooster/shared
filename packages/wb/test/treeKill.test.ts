import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { treeKillCommand } from '../src/commands/treeKill.js';

describe('tree-kill command', () => {
  it('kills target process', async () => {
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const { pid } = proc;
    expect(pid).toBeDefined();
    if (!pid) {
      throw new Error('proc.pid is undefined');
    }

    expect(isProcessRunning(pid)).toBe(true);

    await treeKillCommand.handler({
      pid,
      signal: 'SIGTERM',
    } as never);

    await waitForProcessStopped(pid, 10_000);
  });
});

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForProcessStopped(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await wait(100);
  }
  throw new Error(`Timed out while waiting process ${pid} to stop`);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
