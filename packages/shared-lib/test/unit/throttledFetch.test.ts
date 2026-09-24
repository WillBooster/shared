import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { expect, test } from 'bun:test';

import { createThrottledFetch } from '../../src/throttledFetch.js';

test('createThrottledFetch spaces requests and holds queued ones until Retry-After elapses', async () => {
  const arrivals: number[] = [];
  const server = createServer((request, response) => {
    arrivals.push(performance.now());
    if (arrivals.length === 1) {
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
    const throttledFetch = createThrottledFetch({ intervalMilliseconds: 300, rateLimitFallbackMilliseconds: 60_000 });

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
    expect(arrivals[1]! - arrivals[0]!).toBeGreaterThanOrEqual(950);
    expect(arrivals[2]! - arrivals[1]!).toBeGreaterThanOrEqual(290);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
