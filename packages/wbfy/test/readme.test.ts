import { test, expect } from 'vitest';

import { insertBadge } from '../src/generators/readme.js';

test.each([
  {
    readme: `# wbfy

This is wbfy!`,
    badges: ['[badge]'],
    expected: `# wbfy

[badge]

This is wbfy!`,
  },
  {
    readme: `# wbfy

This is wbfy!`,
    badges: ['[badge2]', '[badge1]'],
    expected: `# wbfy

[badge1]
[badge2]

This is wbfy!`,
  },
  {
    readme: `# wbfy

[badge1]

This is wbfy!`,
    badges: ['[badge2]', '[badge1]'],
    expected: `# wbfy

[badge1]
[badge2]

This is wbfy!`,
  },
])('insert a badge', ({ badges, expected, readme }) => {
  for (const badge of badges) {
    readme = insertBadge(readme, badge);
  }
  expect(readme).toEqual(expected);
});
