import type { Server } from 'node:net';
import { createServer } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../../src/project.js';
import { ensurePort, getEnsuredPort } from '../../src/utils/port.js';

vi.mock('../../src/utils/process.js', () => ({
  killPortProcessImmediatelyAndOnExit: vi.fn().mockResolvedValue(undefined),
}));

const AUTO_PORT_RANGE_START = 20_000;
const AUTO_PORT_RANGE_END_EXCLUSIVE = 32_768 + 100;

function createFakeProject(env: Record<string, string | undefined> = {}): Project {
  return { name: 'wb-port-selection-test', env: { WB_ENV: 'test', ...env } } as unknown as Project;
}

async function occupyPort(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

describe('ensurePort', () => {
  it('respects an explicitly configured PORT and derives no base URL', async () => {
    const project = createFakeProject({ PORT: '3456' });
    await expect(ensurePort(project)).resolves.toBe(3456);
    expect(project.env.NEXT_PUBLIC_BASE_URL).toBeUndefined();
  });

  it('auto-selects a deterministic free port and derives NEXT_PUBLIC_BASE_URL', async () => {
    const project = createFakeProject();
    const port = await ensurePort(project);
    expect(port).toBeGreaterThanOrEqual(AUTO_PORT_RANGE_START);
    expect(port).toBeLessThan(AUTO_PORT_RANGE_END_EXCLUSIVE);
    expect(project.env.PORT).toBe(String(port));
    expect(project.env.NEXT_PUBLIC_BASE_URL).toBe(`http://localhost:${port}`);
    expect(getEnsuredPort(project)).toBe(String(port));

    await expect(ensurePort(createFakeProject())).resolves.toBe(port);
  });

  it('keeps an already-derived NEXT_PUBLIC_BASE_URL', async () => {
    const project = createFakeProject({ NEXT_PUBLIC_BASE_URL: 'http://localhost:1234' });
    await ensurePort(project);
    expect(project.env.NEXT_PUBLIC_BASE_URL).toBe('http://localhost:1234');
  });

  it('searches upward when the preferred port is occupied', async () => {
    const preferredPort = await ensurePort(createFakeProject());
    const server = await occupyPort(preferredPort);
    try {
      const fallbackPort = await ensurePort(createFakeProject());
      expect(fallbackPort).toBeGreaterThan(preferredPort);
      expect(fallbackPort).toBeLessThan(preferredPort + 100);
    } finally {
      server.close();
    }
  });

  it('selects distinct preferred ports per WB_ENV', async () => {
    const developmentPort = await ensurePort(createFakeProject({ WB_ENV: 'development' }));
    const testPort = await ensurePort(createFakeProject({ WB_ENV: 'test' }));
    expect(developmentPort).not.toBe(testPort);
  });
});

describe('getEnsuredPort', () => {
  it('fails fast when the port is not resolved yet', () => {
    expect(() => getEnsuredPort(createFakeProject())).toThrow('ensurePort');
  });
});
