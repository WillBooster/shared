import { afterEach, expect, test } from 'bun:test';

import { sleep } from '../../src/sleep.js';
import { createThrottledFetch } from '../../src/throttledFetch.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('createThrottledFetch spaces request starts and extends the wait of queued requests after a 429', async () => {
  // The test decides when the 429 arrives, since a real server's response latency cannot be bounded.
  const rateLimited = Promise.withResolvers<Response>();
  const starts = new Map<string, number>();
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      starts.set(url, performance.now());
      return url === '/first' ? rateLimited.promise : new Response(url);
    },
    { preconnect: originalFetch.preconnect }
  );
  const throttledFetch = createThrottledFetch({ intervalMilliseconds: 1000, rateLimitFallbackMilliseconds: 60_000 });

  const pendingResponses = Promise.all([throttledFetch('/first'), throttledFetch('/second'), throttledFetch('/third')]);
  await sleep(10);
  // `/second` is now waiting for its slot 1 s after `/first`, so the 429 must extend that wait.
  expect([...starts.keys()]).toEqual(['/first']);
  const rateLimitedAt = performance.now();
  rateLimited.resolve(new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }));

  const responses = await pendingResponses;
  expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
    'rate limited',
    '/second',
    '/third',
  ]);
  expect(starts.get('/second')! - rateLimitedAt).toBeGreaterThanOrEqual(2000);
  expect(starts.get('/third')! - starts.get('/second')!).toBeGreaterThanOrEqual(1000);
});
