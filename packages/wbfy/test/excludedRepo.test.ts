import { expect, test } from 'vitest';

import { isExcludedRepo } from '../src/utils/excludedRepo.js';

// The manifest names the repository canonically, so a renamed checkout directory must not change
// the decision — and a fork under another org keeps its excluded name.
test.each([
  { url: 'git+https://github.com/WillBoosterLab/exercode.git', excluded: true },
  { url: 'https://github.com/WillBoosterLab/exercode', excluded: true },
  { url: 'git+https://github.com/WillBoosterLab/exercode-sakamoto-smartse-courses.git', excluded: false },
  { url: 'git+https://github.com/WillBooster/shared.git', excluded: false },
])('treats $url as excluded=$excluded', ({ url, excluded }) => {
  expect(isExcludedRepo('/tmp/whatever', { repository: { type: 'git', url } })).toBe(excluded);
});

test('falls back to the checkout directory name without a repository field', () => {
  expect(isExcludedRepo('/tmp/exercode', {})).toBe(true);
  expect(isExcludedRepo('/tmp/shared', {})).toBe(false);
});
