import { expect, test } from 'vitest';

import { errorify, withRetry } from '../../src/error.js';

test('errorify keeps a diagnostic for values JSON cannot serialize', () => {
  expect(errorify(undefined).message).toBe('undefined');
  expect(errorify(Symbol('reason')).message).toBe('Symbol(reason)');
  expect(errorify({ a: 1 }).message).toBe('{"a":1}');
});

test('errorify converts instead of throwing when no representation works', () => {
  // It runs in catch blocks, where a throw would replace the error it was asked to convert.
  const unrepresentable = {
    toJSON: () => {},
    toString: () => {
      throw new Error('coercion failed');
    },
  };
  expect(errorify(unrepresentable).message).toBe('');
  expect(errorify(1n).message).toBe('1');
});

test('withRetry waits as long as getSleepMilliseconds decides while advancing its own backoff', async () => {
  const decided: number[] = [];
  const startedAt = Date.now();
  await expect(
    withRetry(
      () => {
        throw new Error('fail');
      },
      {
        retryCount: 3,
        sleepMilliseconds: 1,
        updateSleepMilliseconds: (ms) => ms * 10,
        getSleepMilliseconds: (_, ms) => {
          decided.push(ms);
          return 100;
        },
      }
    )
  ).rejects.toThrow('fail');
  expect(decided).toEqual([1, 10]);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
});
