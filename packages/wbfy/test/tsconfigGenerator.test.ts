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

test('generates explicit TS 6 types and rootDir for a root package', async () => {
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
  expect(tsconfig.compilerOptions.noEmit).toBe(true);
  expect(tsconfig.compilerOptions.rootDir).toBe('.');
  expect(tsconfig.compilerOptions.types).toEqual(['node', 'vitest/globals']);
  expect(tsconfig.include).toContain('*.config.ts');
});

test('sets rootDir for monorepos without root sources', async () => {
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
  expect(tsconfig.compilerOptions.noEmit).toBe(true);
  expect(tsconfig.compilerOptions.rootDir).toBe('.');
  expect(tsconfig.compilerOptions.types).toEqual(['node']);
});

test('resets emit rootDir because build-ts owns src-only declaration emit', async () => {
  const dirPath = createTempDir();
  await fs.promises.mkdir(path.join(dirPath, 'src'), { recursive: true });
  await fs.promises.writeFile(path.join(dirPath, 'src', 'index.ts'), 'export const value = 1;\n');
  await fs.promises.writeFile(
    path.join(dirPath, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        declaration: true,
        noEmit: false,
        outDir: 'dist',
        rootDir: './src',
        sourceMap: true,
      },
      include: ['src/**/*'],
    })
  );

  await generateTsconfig(
    createConfig({
      dirPath,
      doesContainPackageJson: true,
      doesContainTypeScript: true,
    })
  );
  await promisePool.promiseAll();

  const tsconfig = await readTsconfig(dirPath);
  expect(tsconfig.compilerOptions.declaration).toBe(true);
  expect(tsconfig.compilerOptions.noEmit).toBe(true);
  expect(tsconfig.compilerOptions.outDir).toBe('dist');
  expect(tsconfig.compilerOptions.rootDir).toBe('.');
  expect(tsconfig.compilerOptions.sourceMap).toBe(true);
});

test('sets subpackage rootDir to the repository root', async () => {
  const dirPath = createTempDir();
  const packageDirPath = path.join(dirPath, 'packages', 'pkg-a');
  await fs.promises.mkdir(path.join(packageDirPath, 'src'), { recursive: true });
  await fs.promises.writeFile(path.join(dirPath, 'package.json'), '{"private":true}\n');
  await fs.promises.writeFile(path.join(packageDirPath, 'src', 'index.ts'), 'export const value = 1;\n');

  await generateTsconfig(
    createConfig({
      dirPath: packageDirPath,
      isRoot: false,
      doesContainPackageJson: true,
      doesContainTypeScript: true,
    })
  );
  await promisePool.promiseAll();

  const tsconfig = await readTsconfig(packageDirPath);
  expect(tsconfig.compilerOptions.noEmit).toBe(true);
  expect(tsconfig.compilerOptions.rootDir).toBe('../..');
  expect(tsconfig.compilerOptions.types).toEqual(['node']);
});

test('drops stale generated test globals when the package dependency is absent', async () => {
  const dirPath = createTempDir();
  await fs.promises.mkdir(path.join(dirPath, 'src'), { recursive: true });
  await fs.promises.writeFile(path.join(dirPath, 'src', 'index.ts'), 'export const value = 1;\n');
  await fs.promises.writeFile(
    path.join(dirPath, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        types: ['node', 'vitest/globals', 'custom-test-env'],
      },
      include: ['src/**/*'],
    })
  );

  await generateTsconfig(
    createConfig({
      dirPath,
      doesContainPackageJson: true,
      doesContainTypeScript: true,
      packageJson: {
        devDependencies: {
          typescript: '^6.0.0',
        },
      },
    })
  );
  await promisePool.promiseAll();

  const tsconfig = await readTsconfig(dirPath);
  expect(tsconfig.compilerOptions.types).toEqual(['node', 'custom-test-env']);
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-tsconfig-'));
  tempDirs.push(tempDir);
  return tempDir;
}

async function readTsconfig(dirPath: string): Promise<{
  compilerOptions: {
    declaration?: boolean;
    noEmit?: boolean;
    outDir?: string;
    rootDir?: string;
    sourceMap?: boolean;
    types?: string[];
  };
  include?: string[];
}> {
  return JSON.parse(await fs.promises.readFile(path.join(dirPath, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: {
      declaration?: boolean;
      noEmit?: boolean;
      outDir?: string;
      rootDir?: string;
      sourceMap?: boolean;
      types?: string[];
    };
    include?: string[];
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
