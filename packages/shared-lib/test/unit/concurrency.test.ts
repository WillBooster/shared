import { expect, test } from 'bun:test';

import { forEachConcurrently } from '../../src/concurrency.js';
import { sleep } from '../../src/sleep.js';

test('forEachConcurrently keeps at most the given number of actions in flight and visits every item', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const visited: number[] = [];
  await forEachConcurrently([30, 1, 1, 1, 1, 1], 2, async (milliseconds) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(milliseconds);
    visited.push(milliseconds);
    inFlight--;
  });
  expect(maxInFlight).toBe(2);
  // The slow first item does not block the others, which all finish on the second worker before it.
  expect(visited).toEqual([1, 1, 1, 1, 1, 30]);
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
