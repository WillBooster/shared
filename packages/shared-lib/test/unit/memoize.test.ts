import { expect, test } from 'bun:test';

import { cached, memoize } from '../../src/memoize.js';
import { sleep } from '../../src/sleep.js';

test('memoize evicts the least recently used result beyond maxSize', () => {
  const calls: number[] = [];
  const double = memoize(
    (value: number) => {
      calls.push(value);
      return value * 2;
    },
    { maxSize: 2 }
  );
  double(1);
  double(2);
  double(1);
  double(3);
  double(1);
  double(2);
  expect(calls).toEqual([1, 2, 3, 2]);
});

test('memoize drops a rejected promise so that the next call retries', async () => {
  let attempts = 0;
  const fetchValue = memoize(async () => {
    attempts++;
    if (attempts === 1) throw new Error('transient');
    return 'ok';
  });
  expect(String(await fetchValue().catch((error: unknown) => error))).toBe('Error: transient');
  expect(await fetchValue()).toBe('ok');
  expect(await fetchValue()).toBe('ok');
  expect(attempts).toBe(2);
});

test('cached computes a getter once per instance and keeps in-place mutations', () => {
  class Config {
    computeCount = 0;

    @cached
    get values(): Record<string, string> {
      this.computeCount++;
      return { mode: 'test' };
    }
  }
  const first = new Config();
  const second = new Config();
  first.values.mode = 'changed';
  expect(first.values.mode).toBe('changed');
  expect(second.values.mode).toBe('test');
  expect([first.computeCount, second.computeCount]).toEqual([1, 1]);
});

const keyPatterns: [string, (step: number) => number][] = [
  ['rotating keys', (step) => step],
  ['one hot key after a burst', () => 0],
  ['a few new keys after a burst', (step) => (step % 25 === 0 ? 2000 + step : 0)],
];

test.each(keyPatterns)('memoize releases expired results under %s', async (_name, keyAtStep) => {
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  const refs: WeakRef<object>[] = [];
  let load: (id: number) => object;
  try {
    load = memoize(
      (id: number) => {
        const value = { id };
        refs.push(new WeakRef(value));
        return value;
      },
      { ttlMs: 1000 }
    );
    for (let id = 0; id < 1000; id++) load(id);
    for (let step = 1; step <= 1000; step++) {
      now += 1000;
      load(keyAtStep(step));
    }
  } finally {
    Date.now = originalNow;
  }
  // A WeakRef keeps its target alive until the current job ends, so collect after yielding.
  await sleep(0);
  Bun.gc(true);
  // Only results inserted within the last two TTLs may remain.
  expect(refs.filter((ref) => ref.deref()).length).toBeLessThanOrEqual(3);
  // Referencing `load` keeps its cache reachable during the collection above.
  expect(load).toBeFunction();
});
