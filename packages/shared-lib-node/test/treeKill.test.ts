import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { treeKill } from '../src/treeKill.js';

type ChildProcessWithPipeOut = ChildProcessByStdio<null, Readable, Readable>;

describe('treeKill', () => {
  it('kills parent and descendant processes', async () => {
    const { childPid, parent } = await spawnProcessTree();
    expect(parent.pid).toBeDefined();
    expect(isProcessRunning(parent.pid as number)).toBe(true);
    expect(isProcessRunning(childPid)).toBe(true);

    await treeKill(parent.pid as number);

    await Promise.all([
      waitForProcessStopped(parent.pid as number, 10_000),
      waitForProcessStopped(childPid, 10_000),
      waitForClose(parent, 10_000),
    ]);
  }, 30_000);

  it('does not throw when process is already gone', async () => {
    await expect(treeKill(999_999_999)).resolves.toBeUndefined();
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

async function spawnProcessTree(): Promise<{ parent: ChildProcessWithPipeOut; childPid: number }> {
  const parent = spawn(
    process.execPath,
    [
      '-e',
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        'console.log(child.pid);',
        'setInterval(() => {}, 1000);',
      ].join(''),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  parent.stdout.setEncoding('utf8');
  parent.stderr.setEncoding('utf8');
  const childPid = await readChildPid(parent, 10_000);
  return { parent, childPid };
}

async function readChildPid(parent: ChildProcessWithPipeOut, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out while waiting child pid. stdout=${stdout}, stderr=${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk: string): void => {
      stdout += chunk;
      const matched = /^\s*(\d+)\s*$/m.exec(stdout);
      if (!matched) {
        return;
      }

      cleanup();
      resolve(Number(matched[1]));
    };
    const onStderr = (chunk: string): void => {
      stderr += chunk;
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`Parent process exited before printing child pid. stdout=${stdout}, stderr=${stderr}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      parent.stdout.off('data', onStdout);
      parent.stderr.off('data', onStderr);
      parent.off('close', onClose);
    };

    parent.stdout.on('data', onStdout);
    parent.stderr.on('data', onStderr);
    parent.on('close', onClose);
  });
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

async function waitForClose(proc: ChildProcessWithPipeOut, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.removeListener('close', onClose);
      reject(new Error('Timed out while waiting process close event'));
    }, timeoutMs);
    const onClose = (): void => {
      clearTimeout(timer);
      resolve();
    };
    proc.once('close', onClose);
  });
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
