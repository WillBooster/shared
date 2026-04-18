import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PackageJson } from 'type-fest';
import { describe, expect, test } from 'vitest';

import { generatePackageJson } from '../src/generators/packageJson.js';
import type { PackageConfig } from '../src/packageConfig.js';
import { promisePool } from '../src/utils/promisePool.js';

describe('generatePackageJson', () => {
  test('preserves lint peer dependencies for published willbooster config packages', async () => {
    const dirPath = await createPackageDir({
      name: '@willbooster/eslint-config-ts',
      files: ['eslint.config.js'],
      devDependencies: {
        '@eslint/js': '10.0.1',
        '@types/eslint': '9.6.1',
        '@willbooster/prettier-config': '^10.4.0',
        eslint: '10.2.0',
        prettier: '3.8.1',
        'sort-package-json': '3.6.1',
      },
      peerDependencies: {
        '@eslint/js': '>=10',
        eslint: '>=10',
      },
    });
    const config = createConfig({
      dirPath,
      isWillBoosterConfigs: true,
      packageJson: readPackageJson(dirPath),
    });

    await generatePackageJson(config, createRootConfig(path.dirname(dirPath)), true);
    await promisePool.promiseAll();

    const packageJson = readPackageJson(dirPath);
    expect(packageJson.devDependencies).toMatchObject({
      '@eslint/js': '10.0.1',
      '@types/eslint': '9.6.1',
      eslint: '10.2.0',
    });
    expect(packageJson.peerDependencies).toEqual({
      '@eslint/js': '>=10',
      eslint: '>=10',
    });
  });

  test('removes obsolete lint dependencies from regular packages', async () => {
    const dirPath = await createPackageDir({
      name: 'regular-package',
      devDependencies: {
        '@eslint/js': '10.0.1',
        '@willbooster/prettier-config': '^10.4.0',
        eslint: '10.2.0',
        prettier: '3.8.1',
        'sort-package-json': '3.6.1',
      },
      peerDependencies: {
        '@eslint/js': '>=10',
        eslint: '>=10',
      },
    });
    const config = createConfig({
      dirPath,
      packageJson: readPackageJson(dirPath),
    });

    await generatePackageJson(config, createRootConfig(path.dirname(dirPath)), true);
    await promisePool.promiseAll();

    const packageJson = readPackageJson(dirPath);
    expect(packageJson.devDependencies).not.toHaveProperty('@eslint/js');
    expect(packageJson.devDependencies).not.toHaveProperty('eslint');
    expect(packageJson).not.toHaveProperty('peerDependencies');
  });

  test('generates i18n types after install when gen-i18n-ts is used', async () => {
    const dirPath = await createPackageDir({
      name: 'i18n-package',
      private: true,
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
      scripts: {
        'gen-i18n-ts': 'gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP',
        postinstall: 'custom-setup',
      },
    });
    const config = createConfig({
      dirPath,
      isRoot: true,
      depending: {
        ...createConfig().depending,
        genI18nTs: true,
      },
      packageJson: readPackageJson(dirPath),
    });

    await generatePackageJson(config, config, true);
    await promisePool.promiseAll();

    const packageJson = readPackageJson(dirPath);
    expect(packageJson.scripts?.postinstall).toBe('yarn run gen-i18n-ts > /dev/null');
  });
});

async function createPackageDir(packageJson: PackageJson): Promise<string> {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-json-'));
  await fs.promises.writeFile(path.join(dirPath, 'package.json'), `${JSON.stringify(packageJson, undefined, 2)}\n`);
  await fs.promises.writeFile(path.join(dirPath, '.prettierignore'), '');
  return dirPath;
}

function readPackageJson(dirPath: string): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8')) as PackageJson;
}

function createRootConfig(dirPath: string): PackageConfig {
  return createConfig({
    dirPath,
    isRoot: true,
    packageJson: {
      name: 'root',
      private: true,
    },
  });
}

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
