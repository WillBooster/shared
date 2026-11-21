import { expect, test } from 'bun:test';

import { cached, memoize } from '../../src/memoize.js';

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
