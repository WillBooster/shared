import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { generateTsconfig } from '../src/generators/tsconfig.js';
import type { PackageConfig } from '../src/packageConfig.js';
import { promisePool } from '../src/utils/promisePool.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dirPath) => fs.promises.rm(dirPath, { force: true, recursive: true })));
  tempDirs.length = 0;
});

test('generates explicit TS 6 types and preserves inferred rootDir for src-only projects', async () => {
  const dirPath = createTempDir();
  await fs.promises.mkdir(path.join(dirPath, 'src'), { recursive: true });
  await fs.promises.writeFile(path.join(dirPath, 'src', 'index.ts'), 'export const value = 1;\n');

  await generateTsconfig(
    createConfig({
      dirPath,
      doesContainPackageJson: true,
      doesContainTypeScript: true,
      packageJson: {
        devDependencies: {
          typescript: '^6.0.0',
          vitest: '^4.0.0',
        },
      },
    })
  );
  await promisePool.promiseAll();

  const tsconfig = await readTsconfig(dirPath);
  expect(tsconfig.compilerOptions.noEmit).toBe(false);
  expect(tsconfig.compilerOptions.rootDir).toBe('./src');
  expect(tsconfig.compilerOptions.types).toEqual(['node', 'vitest/globals']);
});

test('omits rootDir for monorepos without root sources', async () => {
  const dirPath = createTempDir();
  await fs.promises.mkdir(path.join(dirPath, 'packages', 'pkg-a', 'src'), { recursive: true });
  await fs.promises.writeFile(path.join(dirPath, 'packages', 'pkg-a', 'src', 'index.ts'), 'export const value = 1;\n');

  await generateTsconfig(
    createConfig({
      dirPath,
      doesContainPackageJson: true,
      doesContainSubPackageJsons: true,
      doesContainTypeScriptInPackages: true,
      packageJson: {
        private: true,
        workspaces: ['packages/*'],
      },
    })
  );
  await promisePool.promiseAll();

  const tsconfig = await readTsconfig(dirPath);
  expect(tsconfig.compilerOptions.noEmit).toBe(false);
  expect(tsconfig.compilerOptions.rootDir).toBeUndefined();
  expect(tsconfig.compilerOptions.types).toEqual(['node']);
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-tsconfig-'));
  tempDirs.push(tempDir);
  return tempDir;
}

async function readTsconfig(dirPath: string): Promise<{
  compilerOptions: { noEmit?: boolean; rootDir?: string; types?: string[] };
}> {
  return JSON.parse(await fs.promises.readFile(path.join(dirPath, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: { noEmit?: boolean; rootDir?: string; types?: string[] };
  };
}

function createConfig(overrides: Partial<PackageConfig> = {}): PackageConfig {
  return {
    dirPath: '/tmp',
    dockerfile: '',
    isRoot: true,
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
    doesContainPackageJson: false,
    doesContainPoetryLock: false,
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
    packageJson: {},
    ...overrides,
  };
}
