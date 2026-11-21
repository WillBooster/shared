import { expect, expectTypeOf, test } from 'bun:test';

import { cached, createMemoizeGroup, memoize } from '../../src/memoize.js';
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
  // Only results inserted within the last two TTLs may remain.
  expect(await collectUntil(refs, 3)).toBeLessThanOrEqual(3);
  // Referencing `load` keeps its cache reachable during the collection above.
  expect(load).toBeFunction();
});

test('memoize releases expired results on a cache hit without recomputing the hit key', async () => {
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  const refs: WeakRef<object>[] = [];
  let load: (id: number) => object;
  let hotValue: object;
  try {
    load = memoize(
      (id: number) => {
        const value = { id };
        refs.push(new WeakRef(value));
        return value;
      },
      { ttlMs: 1000 }
    );
    for (let id = 0; id < 100; id++) load(id);
    now = 500;
    hotValue = load(-1);
    now = 1000;
    expect(load(-1)).toBe(hotValue);
  } finally {
    Date.now = originalNow;
  }
  expect(refs.length).toBe(101);
  expect(await collectUntil(refs, 1)).toBe(1);
  // Referencing `load` and `hotValue` keeps them reachable during the collection above.
  expect(load).toBeFunction();
  expect(hotValue).toEqual({ id: -1 });
});

test('a memoize group clears every member, and a rejection from before the clear keeps the newer result', async () => {
  const group = createMemoizeGroup();
  let attempts = 0;
  const first = Promise.withResolvers<string>();
  const load = memoize(
    () => {
      attempts++;
      return attempts === 1 ? first.promise : Promise.resolve('fresh');
    },
    { group }
  );
  let doubled = 0;
  const double = memoize(
    (value: number) => {
      doubled++;
      return value * 2;
    },
    { group }
  );
  double(1);
  const stale = load();
  // Live memoized functions keep their weak group registrations through a collection after the creating job ends.
  await sleep(0);
  Bun.gc(true);
  group.clear();
  const fresh = load();
  double(1);
  first.reject(new Error('stale failure'));
  await stale.catch(() => {});
  expect(await fresh).toBe('fresh');
  expect(load()).toBe(fresh);
  expect([attempts, doubled]).toEqual([2, 2]);
});

test('a memoize group lets the cache of a discarded function be collected', async () => {
  const group = createMemoizeGroup();
  const resultRef = ((): WeakRef<object> => {
    const load = memoize(() => ({ value: 'cached' }), { group });
    return new WeakRef(load());
  })();
  expect(await collectUntil([resultRef], 0)).toBe(0);
  expect(() => group.clear()).not.toThrow();
});

test('a sweep triggered by one group member releases the expired results of the others', async () => {
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  const group = createMemoizeGroup();
  let idleResultRef: WeakRef<object>;
  let active: (id: number) => object;
  let idle: () => object;
  try {
    active = memoize((id: number) => ({ id }), { group, ttlMs: 1000 });
    idle = memoize(() => ({ idle: true }), { group, ttlMs: 1000 });
    active(0);
    idleResultRef = new WeakRef(idle());
    now = 1500;
    active(1);
  } finally {
    Date.now = originalNow;
  }
  expect(await collectUntil([idleResultRef], 0)).toBe(0);
  // Referencing both functions keeps their caches reachable during the collection above.
  expect([active, idle]).toHaveLength(2);
});

test('a call of a short-TTL group member releases a longer-TTL member result as soon as it expires', async () => {
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  const group = createMemoizeGroup();
  let idleResultRef: WeakRef<object>;
  let active: (id: number) => object;
  let idle: () => object;
  try {
    active = memoize((id: number) => ({ id }), { group, ttlMs: 100 });
    idle = memoize(() => ({ idle: true }), { group, ttlMs: 1000 });
    active(0);
    now = 50;
    idleResultRef = new WeakRef(idle());
    now = 1000;
    active(1);
    now = 1100;
    active(2);
  } finally {
    Date.now = originalNow;
  }
  expect(await collectUntil([idleResultRef], 0)).toBe(0);
  // Referencing both functions keeps their caches reachable during the collection above.
  expect([active, idle]).toHaveLength(2);
});

test('memoize keeps the exact types of generic, explicitly typed, and key-typed callbacks', () => {
  const firstItem = memoize(<T>(items: readonly T[]): T | undefined => items[0]);
  expectTypeOf(firstItem(['a', 'b'])).toEqualTypeOf<string | undefined>();
  expectTypeOf(firstItem([1, 2])).toEqualTypeOf<number | undefined>();

  const upper = memoize<[string], string>((text) => text.toUpperCase());
  expectTypeOf(upper).parameters.toEqualTypeOf<[string]>();
  expectTypeOf(upper).returns.toEqualTypeOf<string>();

  const lower = memoize((text) => text.toLowerCase(), { key: (text: string) => text });
  expectTypeOf(lower).parameters.toEqualTypeOf<[string]>();
  expectTypeOf(lower).returns.toEqualTypeOf<string>();

  expect([firstItem([1, 2]), upper('a'), lower('B')]).toEqual([1, 'A', 'b']);
});

/** Collects garbage until at most `maxLiveCount` of `refs` remain or 10 attempts pass, and returns the live count. */
async function collectUntil(refs: readonly WeakRef<object>[], maxLiveCount: number): Promise<number> {
  let liveCount = refs.length;
  for (let attempt = 0; attempt < 10 && liveCount > maxLiveCount; attempt++) {
    // A WeakRef keeps its target alive until the job that created or dereferenced it ends, so collect after yielding.
    await sleep(0);
    Bun.gc(true);
    liveCount = refs.filter((ref) => ref.deref()).length;
  }
  return liveCount;
}
