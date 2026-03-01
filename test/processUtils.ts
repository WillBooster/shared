import { spawnSync } from 'node:child_process';

import { isErrnoException } from '../packages/shared-lib-node/src/errno.js';
import { buildChildrenByParentMap, collectDescendantPids } from '../packages/shared-lib-node/src/processTree.js';

export function isProcessRunning(pid: number): boolean {
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

export async function waitForProcessStopped(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await wait(100);
  }
  throw new Error(`Timed out while waiting process ${pid} to stop`);
}

export async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function listDescendantPids(rootPid: number): number[] {
  const result = spawnSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' });
  const childrenByParent = buildChildrenByParentMap(result.stdout);
  return collectDescendantPids(rootPid, childrenByParent);
}

export function createTreeScript(depth: number): string {
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
