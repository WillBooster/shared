import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { isProcessRunning, waitForProcessStopped } from '../../../test/processUtils.js';
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
