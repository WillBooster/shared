import { expect, test } from 'vitest';

import { errorify } from '../../src/error.js';

test('errorify keeps a diagnostic for values JSON cannot serialize', () => {
  expect(errorify(undefined).message).toBe('undefined');
  expect(errorify(Symbol('reason')).message).toBe('Symbol(reason)');
  expect(errorify({ a: 1 }).message).toBe('{"a":1}');
});
