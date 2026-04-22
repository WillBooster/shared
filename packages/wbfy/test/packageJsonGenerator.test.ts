import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PackageJson } from 'type-fest';
import { describe, expect, test } from 'vitest';

import { generatePackageJson } from '../src/generators/packageJson.js';
import type { PackageConfig } from '../src/packageConfig.js';
import { promisePool } from '../src/utils/promisePool.js';
import { createConfig } from './testConfig.js';

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

    const packageJson = readPackageJson(dirPath);
    expect(packageJson.scripts?.postinstall).toBe('yarn run gen-i18n-ts > /dev/null');
  });

  test('keeps typescript for next.js packages', async () => {
    const dirPath = await createPackageDir({
      name: 'next-package',
      private: true,
      dependencies: {
        next: '16.1.6',
      },
      devDependencies: {
        typescript: '6.0.3',
      },
    });
    const config = createConfig({
      dirPath,
      depending: {
        ...createConfig().depending,
        next: true,
      },
      packageJson: readPackageJson(dirPath),
    });

    await generatePackageJson(config, createRootConfig(path.dirname(dirPath)), true);

    const packageJson = readPackageJson(dirPath);
    expect(packageJson.devDependencies?.typescript).toBe('6.0.3');
  });

  test('adds typescript for next.js packages that use tsgo', { timeout: 30_000 }, async () => {
    const dirPath = await createPackageDir({
      name: 'next-package',
      private: true,
      dependencies: {
        next: '16.1.6',
      },
      devDependencies: {},
    });
    const config = createConfig({
      dirPath,
      doesContainTypeScript: true,
      depending: {
        ...createConfig().depending,
        next: true,
      },
      packageJson: readPackageJson(dirPath),
    });

    await generatePackageJson(config, createRootConfig(path.dirname(dirPath)), true);

    const packageJson = readPackageJson(dirPath);
    expect(packageJson.devDependencies?.typescript).toMatch(/^6\./u);
    expect(packageJson.devDependencies?.['@typescript/native-preview']).toBeDefined();
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
