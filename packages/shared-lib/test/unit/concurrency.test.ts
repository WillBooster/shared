import { expect, test } from 'bun:test';

import { forEachConcurrently } from '../../src/concurrency.js';
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
