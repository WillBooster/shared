import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { isProcessRunning, listDescendantPids, wait, waitForProcessStopped } from '../../../test/processUtils.js';
import { treeKill } from '../src/treeKill.js';

type ChildProcessWithPipeOut = ChildProcessByStdio<null, Readable, Readable>;

describe('treeKill', () => {
  it('kills parent and descendant processes', async () => {
    const parent = spawnProcessTree(1);
    const { pid: parentPid } = parent;
    expect(parentPid).toBeDefined();
    if (!parentPid) {
      throw new Error('parent.pid is undefined');
    }

    const descendantPids = await waitForDescendantPidsCount(parentPid, 1, 10_000);
    expect(isProcessRunning(parentPid)).toBe(true);
    for (const pid of descendantPids) {
      expect(isProcessRunning(pid)).toBe(true);
    }

    treeKill(parentPid);

    await Promise.all([
      waitForProcessStopped(parentPid, 10_000),
      ...descendantPids.map((pid) => waitForProcessStopped(pid, 10_000)),
      waitForClose(parent, 10_000),
    ]);
  }, 30_000);

  it('kills deep process trees', async () => {
    const parent = spawnProcessTree(2);
    const { pid: parentPid } = parent;
    expect(parentPid).toBeDefined();
    if (!parentPid) {
      throw new Error('parent.pid is undefined');
    }

    const descendantPids = await waitForDescendantPidsCount(parentPid, 2, 10_000);
    treeKill(parentPid);

    await Promise.all([
      waitForProcessStopped(parentPid, 10_000),
      ...descendantPids.map((pid) => waitForProcessStopped(pid, 10_000)),
      waitForClose(parent, 10_000),
    ]);
  }, 30_000);

  it('kills process trees with custom signal', async () => {
    const parent = spawnProcessTree(1);
    const { pid: parentPid } = parent;
    expect(parentPid).toBeDefined();
    if (!parentPid) {
      throw new Error('parent.pid is undefined');
    }

    const descendantPids = await waitForDescendantPidsCount(parentPid, 1, 10_000);
    treeKill(parentPid, 'SIGKILL');

    await Promise.all([
      waitForProcessStopped(parentPid, 10_000),
      ...descendantPids.map((pid) => waitForProcessStopped(pid, 10_000)),
      waitForClose(parent, 10_000),
    ]);
  }, 30_000);

  it('kills repeatedly in rapid succession', async () => {
    for (let i = 0; i < 3; i++) {
      const parent = spawnProcessTree(2);
      const { pid: parentPid } = parent;
      expect(parentPid).toBeDefined();
      if (!parentPid) {
        throw new Error('parent.pid is undefined');
      }

      const descendantPids = await waitForDescendantPidsCount(parentPid, 2, 10_000);
      treeKill(parentPid);

      await Promise.all([
        waitForProcessStopped(parentPid, 10_000),
        ...descendantPids.map((pid) => waitForProcessStopped(pid, 10_000)),
        waitForClose(parent, 10_000),
      ]);
    }
  }, 60_000);

  it('does not throw when process is already gone', () => {
    expect(() => {
      treeKill(999_999_999);
    }).not.toThrow();
  });
});

function spawnProcessTree(depth: number): ChildProcessWithPipeOut {
  return spawn(process.execPath, ['-e', createTreeScript(depth)], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function createTreeScript(depth: number): string {
  let code = 'setInterval(() => {}, 1000);';
  for (let i = 0; i < depth; i++) {
    code = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(code)}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1000);',
    ].join('');
  }
  return code;
}

async function waitForDescendantPidsCount(
  parentPid: number,
  minimumCount: number,
  timeoutMs: number
): Promise<number[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const descendants = listDescendantPids(parentPid);
    if (descendants.length >= minimumCount) {
      return descendants;
    }
    await wait(100);
  }
  throw new Error(`Timed out while waiting descendant processes for ${parentPid}`);
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
