import { expect, test } from 'vitest';

import { ensureTruthy } from '../src/assert.js';

test('ensureTruthy returns the value when truthy', () => {
  expect(ensureTruthy('value', 'ok')).toBe('ok');
  expect(ensureTruthy('value', 1)).toBe(1);
});

test('ensureTruthy throws when value is falsy', () => {
  expect(() => ensureTruthy('value', '')).toThrow('The value of "value" must be truthy.');
});
