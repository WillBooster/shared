import childProcess from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('wb maintenance', () => {
  it('runs start in the foreground until SIGTERM', async () => {
    const port = await findAvailablePort();
    const maintenance = spawnWbMaintenance('start', port, ['--delay-ms', '0']);

    try {
      await waitForHttpStatus(port, 503);
    } finally {
      terminateProcessGroup(maintenance);
      await waitForExit(maintenance);
    }
  }, 20_000);

  it('stops delayed start before it starts listening', async () => {
    const port = await findAvailablePort();
    await removePidFile(port);
    const maintenance = spawnWbMaintenance('start', port, ['--delay-ms', '10000']);

    try {
      await waitForPidFile(port);
      const result = runWbMaintenanceStop(port);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Stopped maintenance server on port ${port}.`);
      await waitForExit(maintenance);
      await expect(fetchStatus(port)).resolves.toBeUndefined();
    } finally {
      terminateProcessGroup(maintenance);
    }
  }, 30_000);

  it('does not start maintenance when the app already listens after the delay', async () => {
    const port = await findAvailablePort();
    await removePidFile(port);
    const maintenance = spawnWbMaintenance('start', port, ['--delay-ms', '100']);
    let server: childProcess.ChildProcess | undefined;

    try {
      await waitForPidFile(port);
      server = spawnNodeServer(port);
      await waitForHttpStatus(port, 200);
      await waitForExit(maintenance);
      await expect(fetchStatus(port)).resolves.toBe(200);
    } finally {
      terminateProcessGroup(maintenance);
      if (server) {
        terminateProcessGroup(server);
      }
    }
  }, 30_000);

  it('stops a listener on the configured port without relying on a pid file', async () => {
    const port = await findAvailablePort();
    await removePidFile(port);
    const server = spawnNodeServer(port);

    try {
      await waitForHttpStatus(port, 200);

      const result = runWbMaintenanceStop(port);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Stopped maintenance server on port ${port}.`);
      await waitForExit(server);
    } finally {
      terminateProcessGroup(server);
    }
  }, 30_000);
});

function spawnWbMaintenance(action: 'start' | 'stop', port: number, args: string[] = []): childProcess.ChildProcess {
  return childProcess.spawn(
    'yarn',
    ['workspace', '@willbooster/wb', 'start', 'maintenance', action, '--quiet-env', ...args],
    {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env, PORT: String(port), WB_ENV: 'development' },
      stdio: 'ignore',
    }
  );
}

function runWbMaintenanceStop(port: number): childProcess.SpawnSyncReturns<string> {
  return childProcess.spawnSync(
    'yarn',
    ['workspace', '@willbooster/wb', 'start', 'maintenance', 'stop', '--quiet-env'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PORT: String(port), WB_ENV: 'development' },
      timeout: 20_000,
    }
  );
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
      `,
    ],
    {
      detached: true,
      stdio: 'ignore',
    }
  );
}

function terminateProcessGroup(child: childProcess.ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // do nothing
  }
}

async function waitForExit(child: childProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

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

async function waitForPidFile(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  const pidFilePath = maintenancePidFilePath(port);
  while (Date.now() < deadline) {
    try {
      await fs.access(pidFilePath);
      return;
    } catch {
      // continue waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${pidFilePath}.`);
}

async function removePidFile(port: number): Promise<void> {
  await fs.rm(maintenancePidFilePath(port), { force: true });
}

function maintenancePidFilePath(port: number): string {
  return path.join(process.cwd(), '..', '..', '.wb', `maintenance-${port}.pid`);
}

async function fetchStatus(port: number): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}`);
    return response.status;
  } catch {
    return;
  }
}
