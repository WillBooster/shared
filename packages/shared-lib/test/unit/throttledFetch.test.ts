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

test('createThrottledFetch holds for Retry-After seconds or IMF-fixdate and falls back for other values', async () => {
  const fallbackMilliseconds = 300;
  // Resolves the 429 immediately and returns how long the next request waited after it.
  const measureHold = async (retryAfter: string | undefined): Promise<number> => {
    let rateLimitedAt = 0;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url !== '/first') return new Response(String(performance.now()));
        rateLimitedAt = performance.now();
        return new Response('', {
          status: 429,
          headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
        });
      },
      { preconnect: originalFetch.preconnect }
    );
    const throttledFetch = createThrottledFetch({
      intervalMilliseconds: 0,
      rateLimitFallbackMilliseconds: fallbackMilliseconds,
    });
    await throttledFetch('/first');
    const next = await throttledFetch('/next');
    return Number(await next.text()) - rateLimitedAt;
  };

  expect(await measureHold('0')).toBeLessThan(fallbackMilliseconds);
  // HTTP dates have whole-second precision, so a date 2 s ahead holds for more than 1 s.
  expect(await measureHold(new Date(Date.now() + 2000).toUTCString())).toBeGreaterThanOrEqual(1000);
  for (const invalid of ['1.5', 'soon', undefined]) {
    const hold = await measureHold(invalid);
    expect(hold).toBeGreaterThanOrEqual(fallbackMilliseconds);
    expect(hold).toBeLessThan(1000);
  }
});
