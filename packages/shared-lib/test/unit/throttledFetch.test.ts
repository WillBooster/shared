import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { afterEach, expect, test } from 'bun:test';

import { createThrottledFetch } from '../../src/throttledFetch.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('createThrottledFetch spaces request starts and holds queued ones until Retry-After elapses', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/first') {
      response.writeHead(429, { 'retry-after': '1' });
      response.end('rate limited');
    } else {
      response.end(request.url);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    // Record when each request starts, which is what the interval applies to; server arrival adds scheduling delay.
    const starts: number[] = [];
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        starts.push(performance.now());
        return originalFetch(...args);
      },
      { preconnect: originalFetch.preconnect }
    );
    const throttledFetch = createThrottledFetch({ intervalMilliseconds: 300, rateLimitFallbackMilliseconds: 60_000 });

    // Only requests started after the 429 arrives can be held, so the others are queued once it is received.
    const rateLimited = await throttledFetch(`${baseUrl}/first`);
    const responses = await Promise.all([throttledFetch(`${baseUrl}/second`), throttledFetch(`${baseUrl}/third`)]);

    expect(rateLimited.status).toBe(429);
    expect(await rateLimited.text()).toBe('rate limited');
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(['/second', '/third']);
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(300);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
