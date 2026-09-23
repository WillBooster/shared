import { expect, test } from 'bun:test';

import { shuffleWithSeed } from '../../src/index.js';

test('shuffleWithSeed produces a stable permutation and mutates its input', () => {
  const input = Array.from({ length: 12 }, (_, index) => index);
  const result = shuffleWithSeed(input, '東京-2026');

  expect(result).toBe(input);
  expect(result).toEqual([6, 5, 4, 0, 11, 9, 1, 3, 2, 7, 10, 8]);
  expect(
    shuffleWithSeed(
      Array.from({ length: 12 }, (_, index) => index),
      '東京-2026'
    )
  ).toEqual(result);
  expect(
    shuffleWithSeed(
      Array.from({ length: 12 }, (_, index) => index),
      '東京-2027'
    )
  ).not.toEqual(result);
});
