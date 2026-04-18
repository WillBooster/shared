import { describe, expect, test } from 'vitest';

import type { PackageConfig } from '../src/packageConfig.js';
import { isPublishedWillboosterConfigsPackage } from '../src/utils/willboosterConfigsUtil.js';

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

function createConfig(overrides: Partial<PackageConfig> = {}): PackageConfig {
  return {
    dirPath: '/tmp',
    dockerfile: '',
    isRoot: false,
    isPublicRepo: true,
    isReferredByOtherRepo: false,
    repository: 'github:WillBooster/example',
    isWillBoosterRepo: true,
    isBun: false,
    isEsmPackage: false,
    isWillBoosterConfigs: false,
    doesContainSubPackageJsons: false,
    doesContainDockerfile: false,
    doesContainGemfile: false,
    doesContainGoMod: false,
    doesContainPackageJson: true,
    doesContainPoetryLock: false,
    doesContainUvLock: false,
    doesContainPomXml: false,
    doesContainPubspecYaml: false,
    doesContainTemplateYaml: false,
    doesContainVscodeSettingsJson: false,
    doesContainJavaScript: false,
    doesContainTypeScript: false,
    doesContainJsxOrTsx: false,
    doesContainJava: false,
    doesContainJavaScriptInPackages: false,
    doesContainTypeScriptInPackages: false,
    doesContainJsxOrTsxInPackages: false,
    doesContainJavaInPackages: false,
    hasStartTestServer: false,
    depending: {
      blitz: false,
      firebase: false,
      genI18nTs: false,
      litestream: false,
      next: false,
      playwrightTest: false,
      prisma: false,
      pyright: false,
      react: false,
      reactNative: false,
      semanticRelease: false,
      storybook: false,
      wb: false,
    },
    release: {
      branches: [],
      github: false,
      npm: false,
    },
    hasVersionSettings: false,
    ...overrides,
  };
}
