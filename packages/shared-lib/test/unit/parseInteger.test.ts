import { expect, test } from 'bun:test';

import { parsePositiveInteger } from '../../src/parseInteger.js';

test('parsePositiveInteger accepts only canonical positive safe integers', () => {
  expect(parsePositiveInteger('1')).toBe(1);
  expect(parsePositiveInteger('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  for (const invalid of ['0', '01', '-1', '+1', '1.0', '1e3', ' 1', '', '9007199254740992']) {
    expect(parsePositiveInteger(invalid)).toBeUndefined();
  }
});
