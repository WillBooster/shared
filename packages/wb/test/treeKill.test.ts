import type { ChildProcessByStdio } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import type { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { treeKillCommand } from '../src/commands/treeKill.js';

type ChildProcessWithPipeOut = ChildProcessByStdio<null, Readable, Readable>;

describe('tree-kill command', () => {
  it('kills target process tree', async () => {
    const parent = spawnProcessTree();
    expect(parent.pid).toBeDefined();
    const childPid = await waitForDescendantPid(parent.pid as number, 10_000);
    expect(isProcessRunning(parent.pid as number)).toBe(true);
    expect(isProcessRunning(childPid)).toBe(true);

    await treeKillCommand.handler({
      pid: parent.pid,
      signal: 'SIGTERM',
    } as never);

    await Promise.all([
      waitForProcessStopped(parent.pid as number, 10_000),
      waitForProcessStopped(childPid, 10_000),
      waitForClose(parent, 10_000),
    ]);
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

function spawnProcessTree(): ChildProcessWithPipeOut {
  return spawn(
    process.execPath,
    [
      '-e',
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        'setInterval(() => {}, 1000);',
      ].join(''),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

async function waitForDescendantPid(pid: number, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const descendants = listDescendantPids(pid);
    if (descendants[0]) {
      return descendants[0];
    }
    await wait(100);
  }
  throw new Error(`Timed out while waiting descendant process for ${pid}`);
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

function listDescendantPids(rootPid: number): number[] {
  const result = spawnSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' });
  const childrenByParent = new Map<number, number[]>();
  for (const line of result.stdout.split('\n')) {
    const matched = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!matched) {
      continue;
    }

    const childPid = Number(matched[1]);
    const parentPid = Number(matched[2]);
    const children = childrenByParent.get(parentPid);
    if (children) {
      children.push(childPid);
    } else {
      childrenByParent.set(parentPid, [childPid]);
    }
  }

  const descendants: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (!pid) {
      continue;
    }

    descendants.push(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) {
      queue.push(childPid);
    }
  }
  return descendants;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
