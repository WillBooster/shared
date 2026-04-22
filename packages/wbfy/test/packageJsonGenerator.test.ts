import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';

import type { PackageJson } from 'type-fest';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { generatePackageJson } from '../src/generators/packageJson.js';
import type { PackageConfig } from '../src/packageConfig.js';
import { promisePool } from '../src/utils/promisePool.js';
import { createConfig } from './testConfig.js';

describe('generatePackageJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    vi.spyOn(childProcess, 'spawnSync').mockImplementation((command, args = []) => {
      const dependency = args[1];
      if (command === 'npm' && args[0] === 'show') {
        if (dependency === '@typescript/native-preview@beta') {
          return { output: [], pid: 1, signal: null, status: 0, stdout: '7.0.0-beta.1', stderr: '' };
        }
        if (dependency === 'typescript') {
          return { output: [], pid: 1, signal: null, status: 0, stdout: '6.0.3', stderr: '' };
        }
        return { output: [], pid: 1, signal: null, status: 0, stdout: '1.0.0', stderr: '' };
      }
      throw new Error(`Unexpected spawnSync call: ${String(command)} ${args.join(' ')}`);
    });

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
    expect(packageJson.devDependencies?.typescript).toMatch(/^\d+\.\d+\.\d+/u);
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
