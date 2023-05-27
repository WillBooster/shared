import { expect, test } from 'vitest';

import { zenkakuAlphanumericalsToHankaku } from '../src/index.js';

test('zenkakuAlphanumericalsToHankaku', () => {
  expect(zenkakuAlphanumericalsToHankaku('ABCＡＢＣABC')).toBe('ABCABCABC');
});
