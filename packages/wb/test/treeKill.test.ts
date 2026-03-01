import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import type { ArgumentsCamelCase } from 'yargs';

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

    runTreeKillHandler(pid, 'SIGTERM');

    await waitForProcessStopped(pid, 10_000);
  });

  it('kills target process with custom signal', async () => {
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const { pid } = proc;
    expect(pid).toBeDefined();
    if (!pid) {
      throw new Error('proc.pid is undefined');
    }

    runTreeKillHandler(pid, 'SIGKILL');

    await waitForProcessStopped(pid, 10_000);
  });
});

function runTreeKillHandler(pid: number, signal: NodeJS.Signals): void {
  const argv = {
    _: [],
    $0: 'wb',
    pid,
    signal,
  } as ArgumentsCamelCase<{ pid: number; signal: string }>;
  void treeKillCommand.handler(argv);
}
