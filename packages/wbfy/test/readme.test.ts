import { expect, test } from 'vitest';

import { insertBadge, removeGitHubActionsBadge } from '../src/generators/readme.js';

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

test('remove GitHub Actions badges for a workflow regardless of repository owner', () => {
  const readme = `# judge

[![Test](https://github.com/WillBoosterLab/judge/actions/workflows/test.yml/badge.svg)](https://github.com/WillBoosterLab/judge/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![Test](https://github.com/WillBooster/judge/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/judge/actions/workflows/test.yml)

## Releases
`;

  expect(removeGitHubActionsBadge(readme, 'Test', 'test.yml')).toBe(`# judge

[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

## Releases
`);
});
