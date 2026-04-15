import { describe, expect, test } from 'vitest';

import type { PackageConfig } from '../src/packageConfig.js';
import { shouldSkipWillboosterConfigsPackage } from '../src/utils/willboosterConfigsUtil.js';

describe('shouldSkipWillboosterConfigsPackage', () => {
  test('does not skip legacy ESLint config packages inside willbooster-configs', () => {
    const config = createConfig({
      isWillBoosterConfigs: true,
      packageJson: { name: '@willbooster/eslint-config-ts' },
    });

    expect(shouldSkipWillboosterConfigsPackage(config)).toBe(false);
  });

  test('skips shared format config packages inside willbooster-configs', () => {
    const config = createConfig({
      isWillBoosterConfigs: true,
      packageJson: { name: '@willbooster/prettier-config' },
    });

    expect(shouldSkipWillboosterConfigsPackage(config)).toBe(true);
  });

  test('does not skip config packages outside willbooster-configs', () => {
    const config = createConfig({
      isWillBoosterConfigs: false,
      packageJson: { name: '@willbooster/oxlint-config' },
    });

    expect(shouldSkipWillboosterConfigsPackage(config)).toBe(false);
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
    doesContainJavaScriptInPackages: false,
    doesContainTypeScriptInPackages: false,
    doesContainJsxOrTsxInPackages: false,
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
