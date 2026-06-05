import { expect, test } from 'vitest';

import { getGenI18nTsCommand } from '../src/utils/genI18nTs.js';
import { createConfig } from './testConfig.js';

const depending = { ...createConfig().depending, genI18nTs: true };

test('does not generate a command for the default gen-i18n-ts script', () => {
  expect(
    getGenI18nTsCommand(
      { depending, isBun: false },
      { 'gen-i18n-ts': 'gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP' }
    )
  ).toBeUndefined();
});

test('generates a command for a custom gen-i18n-ts script', () => {
  expect(
    getGenI18nTsCommand(
      { depending, isBun: false },
      { 'gen-i18n-ts': 'gen-i18n-ts -i locales -o src/i18n.ts -d en-US' }
    )
  ).toBe('yarn run gen-i18n-ts > /dev/null');
});
