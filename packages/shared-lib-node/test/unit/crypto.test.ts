import { expect, test } from 'bun:test';

import { timingSafeEqualString } from '../../src/crypto.js';

test('timingSafeEqualString compares strings of any lengths', () => {
  expect(timingSafeEqualString('secret', 'secret')).toBe(true);
  expect(timingSafeEqualString('secret', 'secreT')).toBe(false);
  expect(timingSafeEqualString('secret', 'secret-longer')).toBe(false);
  expect(timingSafeEqualString('', '')).toBe(true);
});
