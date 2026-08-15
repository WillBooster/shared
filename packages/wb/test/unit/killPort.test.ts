import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { waitForProcessStopped } from '../../../../test/helpers/processUtils.js';
import { killPorts } from '../../src/commands/killPort.js';

describe('kill-port command', () => {
  it('kills the process listening on the given port', async () => {
    const [pid, port] = await startListeningProcess();

    killPorts([port]);

    await waitForProcessStopped(pid, 10_000);
  });

  it('rejects an invalid port before killing anything', async () => {
    const [pid, port] = await startListeningProcess();

    expect(() => killPorts([port, 65_536])).toThrow('Invalid port: 65536');

    process.kill(pid, 'SIGKILL');
    await waitForProcessStopped(pid, 10_000);
  });
});

/** Starts a process listening on an OS-assigned port and returns its pid and that port. */
function startListeningProcess(): Promise<[number, number]> {
  const child = spawn(process.execPath, [
    '-e',
    "const server = require('node:net').createServer(); server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
  ]);
  const { pid } = child;
  if (!pid) throw new Error('Failed to spawn a listening process.');

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (data: Buffer) => {
      resolve([pid, Number(data.toString().trim())]);
    });
  });
}
