import http from 'node:http';
import { once } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findSelfProjectMock = vi.fn();
const killPortContainerAndProcessMock = vi.fn();

vi.mock('../src/project.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/project.js')>()),
  findSelfProject: findSelfProjectMock,
}));

vi.mock('../src/utils/process.js', () => ({
  killPortContainerAndProcess: killPortContainerAndProcessMock,
}));

const { maintenanceCommand } = await import('../src/commands/maintenance.js');

describe('maintenanceCommand', () => {
  beforeEach(() => {
    findSelfProjectMock.mockReset();
    killPortContainerAndProcessMock.mockReset();
    killPortContainerAndProcessMock.mockResolvedValue(undefined);
  });

  it('runs the maintenance server in the foreground until SIGTERM', async () => {
    const port = await findAvailablePort();
    findSelfProjectMock.mockReturnValue({
      env: { PORT: String(port), WB_ENV: 'development' },
    });

    if (!maintenanceCommand.handler) throw new Error('maintenanceCommand.handler is undefined.');

    const handlerPromise = maintenanceCommand.handler({ action: 'start' } as never);
    await waitForHttpStatus(port, 503);

    process.emit('SIGTERM', 'SIGTERM');
    await expect(handlerPromise).resolves.toBeUndefined();
    expect(killPortContainerAndProcessMock).toHaveBeenCalledWith(
      port,
      expect.objectContaining({ env: expect.anything() })
    );
  });

  it('stops maintenance by killing the configured port without requiring a pid file', async () => {
    const project = {
      env: { PORT: '32123', WB_ENV: 'development' },
    };
    findSelfProjectMock.mockReturnValue(project);

    if (!maintenanceCommand.handler) throw new Error('maintenanceCommand.handler is undefined.');

    await maintenanceCommand.handler({ action: 'stop' } as never);

    expect(killPortContainerAndProcessMock).toHaveBeenCalledOnce();
    expect(killPortContainerAndProcessMock).toHaveBeenCalledWith(32123, project);
  });
});

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
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = await fetchStatus(port);
    if (status === expectedStatus) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
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
