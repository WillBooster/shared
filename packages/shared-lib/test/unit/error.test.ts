import { expect, test } from 'vitest';

import { errorify } from '../../src/error.js';

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
