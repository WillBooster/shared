import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { waitForProcessStopped } from '../../../../test/helpers/processUtils.js';
import { killPorts } from '../../src/commands/killPort.js';
import { isPortAvailable } from '../../src/utils/port.js';

describe('kill-port command', () => {
  it('kills the process listening on the given port', async () => {
    const [pid, port] = await startListeningProcess();

    killPorts([String(port)]);

    await waitForProcessStopped(pid, 10_000);
  });

  it('kills no port when another port is invalid', async () => {
    const [pid, port] = await startListeningProcess();

    try {
      expect(() => killPorts([String(port), '65536'])).toThrow('Invalid port: 65536');
      expect(await isPortAvailable(port)).toBe(false);
    } finally {
      process.kill(pid, 'SIGKILL');
    }
    await waitForProcessStopped(pid, 10_000);
  });

  it('kills nothing on a dry run', async () => {
    const [pid, port] = await startListeningProcess();

    try {
      killPorts([String(port)], true);
      expect(await isPortAvailable(port)).toBe(false);
    } finally {
      process.kill(pid, 'SIGKILL');
    }
    await waitForProcessStopped(pid, 10_000);
  });
});

/** Starts a process listening on an OS-assigned port and returns its pid and that port. */
function startListeningProcess(): Promise<[number, number]> {
  const child = spawn(process.execPath, [
    '-e',
    // The port is printed as a string because CI sets FORCE_COLOR, and `console.log` wraps a
    // number argument in ANSI color codes, which `Number()` would read as NaN.
    "const server = require('node:net').createServer(); server.listen(0, '127.0.0.1', () => console.log(String(server.address().port)));",
  ]);
  const { pid } = child;
  if (!pid) throw new Error('Failed to spawn a listening process.');

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    // Without this, a child that dies before printing its port would stall the whole suite until
    // vitest's 10-minute timeout. Rejecting a resolved promise later (on the test's own kill) is a no-op.
    child.once('exit', (code) => reject(new Error(`The listening process exited early with code ${code}.`)));
    child.stdout.once('data', (data: Buffer) => {
      resolve([pid, Number(data.toString().trim())]);
    });
  });
}
