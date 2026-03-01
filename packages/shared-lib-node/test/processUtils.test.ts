import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { isProcessRunning, listDescendantPids, waitForProcessStopped } from '../../../test/processUtils.js';
import { treeKill } from '../src/treeKill.js';

describe('processUtils', () => {
  it('finds descendants for a running process tree', async () => {
    const parent = spawn(process.execPath, ['-e', createTreeScript(2)], { stdio: ['ignore', 'ignore', 'ignore'] });
    const { pid: parentPid } = parent;
    expect(parentPid).toBeDefined();
    if (!parentPid) {
      throw new Error('parent.pid is undefined');
    }

    const descendants = await waitForDescendants(parentPid, 2, 10_000);
    expect(descendants.length).toBeGreaterThanOrEqual(2);

    treeKill(parentPid, 'SIGKILL');
    await waitForProcessStopped(parentPid, 10_000);
    for (const pid of descendants) {
      await waitForProcessStopped(pid, 10_000);
    }
  }, 30_000);

  it('returns empty descendants and false running status for unknown pid', () => {
    const unknownPid = 999_999_999;
    expect(listDescendantPids(unknownPid)).toStrictEqual([]);
    expect(isProcessRunning(unknownPid)).toBe(false);
  });
});

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

async function waitForDescendants(parentPid: number, minimumCount: number, timeoutMs: number): Promise<number[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const descendants = listDescendantPids(parentPid);
    if (descendants.length >= minimumCount) {
      return descendants;
    }
    await wait(100);
  }
  throw new Error(`Timed out while waiting descendants of ${parentPid}`);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
