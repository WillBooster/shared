import { describe, expect, test } from 'vitest';

import { isPublishedWillboosterConfigsPackage } from '../src/utils/willboosterConfigsUtil.js';
import { createConfig } from './testConfig.js';

describe('isPublishedWillboosterConfigsPackage', () => {
  test('detects published config packages inside willbooster-configs', () => {
    const config = createConfig({
      isWillBoosterConfigs: true,
      packageJson: { files: ['eslint.config.js'], name: '@willbooster/eslint-config-ts' },
    });

    expect(isPublishedWillboosterConfigsPackage(config)).toBe(true);
  });

  test('does not detect private helper packages', () => {
    const config = createConfig({
      isWillBoosterConfigs: true,
      packageJson: { name: '@willbooster/shared', private: true },
    });

    expect(isPublishedWillboosterConfigsPackage(config)).toBe(false);
  });

  test('does not detect config packages outside willbooster-configs', () => {
    const config = createConfig({
      isWillBoosterConfigs: false,
      packageJson: { files: ['config.mjs'], name: '@willbooster/oxlint-config' },
    });

    expect(isPublishedWillboosterConfigsPackage(config)).toBe(false);
  });
});
