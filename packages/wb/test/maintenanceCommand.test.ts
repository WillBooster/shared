import childProcess from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

describe('wb maintenance', () => {
  it('runs start in the foreground until SIGTERM', async () => {
    const port = await findAvailablePort();
    const maintenance = spawnWbMaintenance('start', port);

    try {
      await waitForHttpStatus(port, 503);
    } finally {
      terminateProcessGroup(maintenance);
      await waitForExit(maintenance);
    }
  }, 20_000);

  it('stops a listener on the configured port without relying on a pid file', async () => {
    const port = await findAvailablePort();
    const server = spawnNodeServer(port);

    try {
      await waitForHttpStatus(port, 200);

      const result = childProcess.spawnSync(
        'yarn',
        ['workspace', '@willbooster/wb', 'start', 'maintenance', 'stop', '--quiet-env'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, PORT: String(port), WB_ENV: 'development' },
          timeout: 20_000,
        }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Stopped maintenance server on port ${port}.`);
      await waitForExit(server);
    } finally {
      terminateProcessGroup(server);
    }
  }, 30_000);
});

function spawnWbMaintenance(action: 'start' | 'stop', port: number): childProcess.ChildProcess {
  return childProcess.spawn('yarn', ['workspace', '@willbooster/wb', 'start', 'maintenance', action, '--quiet-env'], {
    cwd: process.cwd(),
    detached: true,
    env: { ...process.env, PORT: String(port), WB_ENV: 'development' },
    stdio: 'ignore',
  });
}

function spawnNodeServer(port: number): childProcess.ChildProcess {
  return childProcess.spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import http from 'node:http';
        const server = http.createServer((_request, response) => response.end('ok'));
        server.listen(${JSON.stringify(port)}, '0.0.0.0');
        setInterval(() => {}, 1000);
      `,
    ],
    {
      detached: true,
      stdio: 'ignore',
    }
  );
}

function terminateProcessGroup(child: childProcess.ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // do nothing
  }
}

async function waitForExit(child: childProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;

  let timeoutId: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(child, 'exit'),
      new Promise<void>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out waiting for process ${child.pid ?? '<unknown>'} to exit.`));
        }, 10_000);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function findAvailablePort(): Promise<number> {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to find an available port.');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return address.port;
}

async function waitForHttpStatus(port: number, expectedStatus: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await fetchStatus(port);
    if (status === expectedStatus) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for HTTP ${expectedStatus} on port ${port}.`);
}

async function fetchStatus(port: number): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}`);
    return response.status;
  } catch {
    return;
  }
}
