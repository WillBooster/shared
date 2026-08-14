import type { Server } from 'node:net';
import { createServer } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../../src/project.js';
import { computePreferredPort, ensurePort, getEnsuredPort } from '../../src/utils/port.js';

vi.mock('../../src/utils/process.js', () => ({
  killPortProcessImmediatelyAndOnExit: vi.fn().mockResolvedValue(undefined),
}));

const AUTO_PORT_RANGE_START = 20_000;
const AUTO_PORT_RANGE_END_EXCLUSIVE = 32_768;

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
  it('respects an explicitly configured PORT and derives NEXT_PUBLIC_BASE_URL from it', async () => {
    const project = createFakeProject({ PORT: '3456' });
    await expect(ensurePort(project)).resolves.toBe(3456);
    expect(project.env.NEXT_PUBLIC_BASE_URL).toBe('http://localhost:3456');
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

  it('fails fast on a NEXT_PUBLIC_BASE_URL pinning its port without a matching PORT', async () => {
    const pinnedBaseUrls = [
      'http://localhost:1234',
      'http://localhost-exercode.willbooster.net:3000',
      // `URL#port` hides an explicitly written default port; the raw authority must be inspected.
      'http://localhost:80',
      'https://example.willbooster.com:443',
      // A portless loopback URL pins the scheme's default port.
      'http://localhost',
      'http://127.0.0.1',
    ];
    for (const baseUrl of pinnedBaseUrls) {
      const project = createFakeProject({ NEXT_PUBLIC_BASE_URL: baseUrl });
      await expect(ensurePort(project)).rejects.toThrow('pins its port while PORT is undefined');
    }
  });

  it('keeps a non-loopback NEXT_PUBLIC_BASE_URL', async () => {
    const project = createFakeProject({ NEXT_PUBLIC_BASE_URL: 'https://example.willbooster.com' });
    await ensurePort(project);
    expect(project.env.NEXT_PUBLIC_BASE_URL).toBe('https://example.willbooster.com');
  });

  it('searches another in-range port when the preferred port is occupied', async () => {
    const preferredPort = await ensurePort(createFakeProject());
    const server = await occupyPort(preferredPort);
    try {
      const fallbackPort = await ensurePort(createFakeProject());
      expect(fallbackPort).not.toBe(preferredPort);
      expect(fallbackPort).toBeGreaterThanOrEqual(AUTO_PORT_RANGE_START);
      expect(fallbackPort).toBeLessThan(AUTO_PORT_RANGE_END_EXCLUSIVE);
    } finally {
      server.close();
    }
  });

  it('keeps wrapped fallback probes inside the range at the top edge', async () => {
    // `pkg-3620` in the test environment hashes to the range's last port, 32767.
    const project = { name: 'pkg-3620', env: { WB_ENV: 'test' } } as unknown as Project;
    expect(computePreferredPort(project)).toBe(32_767);
    const server = await occupyPort(32_767);
    try {
      const fallbackPort = await ensurePort(project);
      expect(fallbackPort).toBeGreaterThanOrEqual(AUTO_PORT_RANGE_START);
      expect(fallbackPort).toBeLessThan(AUTO_PORT_RANGE_END_EXCLUSIVE);
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
