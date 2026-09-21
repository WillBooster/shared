import { expect, test } from 'bun:test';

import { zenkakuAlphanumericalsToHankaku } from '../../src/index.js';

test('zenkakuAlphanumericalsToHankaku', () => {
  expect(zenkakuAlphanumericalsToHankaku('ABCＡＢＣABC')).toBe('ABCABCABC');
});
