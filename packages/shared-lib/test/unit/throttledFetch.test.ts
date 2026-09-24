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
      response.writeHead(429, { 'retry-after': '2' });
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
    const throttledFetch = createThrottledFetch({ intervalMilliseconds: 1000, rateLimitFallbackMilliseconds: 60_000 });

    // All three are queued at once, so the 429 arrives while `/second` already waits for its slot 1 s later and must
    // extend that wait to the 2 s `Retry-After`.
    const responses = await Promise.all([
      throttledFetch(`${baseUrl}/first`),
      throttledFetch(`${baseUrl}/second`),
      throttledFetch(`${baseUrl}/third`),
    ]);

    expect(responses[0]?.status).toBe(429);
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      'rate limited',
      '/second',
      '/third',
    ]);
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(2000);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(1000);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
