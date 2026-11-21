import { expect, test } from 'bun:test';

import { createConcurrencyLimiter, forEachConcurrently, mapConcurrently } from '../../src/concurrency.js';
import { sleep } from '../../src/sleep.js';

test('forEachConcurrently keeps at most the given number of actions in flight and does not wait for a slow item', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slowGate = Promise.withResolvers<void>();
  const visited: string[] = [];
  // The slow item is released only by the last fast one, so this settles only if the other worker drains the rest.
  await forEachConcurrently(['slow', 'a', 'b', 'c', 'd'], 2, async (item) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await (item === 'slow' ? slowGate.promise : Promise.resolve());
    visited.push(item);
    if (item === 'd') slowGate.resolve();
    inFlight--;
  });
  expect(maxInFlight).toBe(2);
  expect(visited).toEqual(['a', 'b', 'c', 'd', 'slow']);
});

test('forEachConcurrently rejects with the first error and starts no further items', async () => {
  const started: number[] = [];
  const promise = forEachConcurrently([1, 2, 3, 4], 1, async (item) => {
    started.push(item);
    if (item === 2) throw new Error('failed at 2');
  });
  expect(String(await promise.catch((error: unknown) => error))).toBe('Error: failed at 2');
  expect(started).toEqual([1, 2]);
});

test('forEachConcurrently rejects only after every started action has settled', async () => {
  let settled = false;
  const promise = forEachConcurrently([1, 2], 2, async (item) => {
    if (item === 2) throw new Error('failed at 2');
    await sleep(20);
    settled = true;
  });
  expect(String(await promise.catch((error: unknown) => error))).toBe('Error: failed at 2');
  expect(settled).toBe(true);
});

test('mapConcurrently resolves with results in item order even when later items finish first', async () => {
  const firstGate = Promise.withResolvers<void>();
  const results = await mapConcurrently(['a', 'b', 'c'], 2, async (item, index) => {
    if (index === 0) await firstGate.promise;
    if (index === 2) firstGate.resolve();
    return `${item}${index}`;
  });
  expect(results).toEqual(['a0', 'b1', 'c2']);
});

test('createConcurrencyLimiter caps tasks in flight across calls and settles each call with its own task result', async () => {
  const runWithLimit = createConcurrencyLimiter(2);
  let inFlight = 0;
  let maxInFlight = 0;
  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5].map((item) =>
      runWithLimit(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(5);
        inFlight--;
        if (item === 3) throw new Error('failed at 3');
        return item * 10;
      })
    )
  );
  expect(maxInFlight).toBe(2);
  expect(results.map((result) => (result.status === 'fulfilled' ? result.value : String(result.reason)))).toEqual([
    10,
    20,
    'Error: failed at 3',
    40,
    50,
  ]);
});

test('createConcurrencyLimiter frees the slot of a rejected task for a queued one', async () => {
  const runWithLimit = createConcurrencyLimiter(1);
  const rejected = runWithLimit(() => Promise.reject(new Error('failed first')));
  const queued = runWithLimit(() => Promise.resolve('ran second'));
  expect(String(await rejected.catch((error: unknown) => error))).toBe('Error: failed first');
  expect(await queued).toBe('ran second');
});
