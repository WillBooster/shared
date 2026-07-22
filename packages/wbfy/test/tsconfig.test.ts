import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateTsconfig } from '../src/generators/tsconfig.js';
import type { PackageConfig } from '../src/packageConfig.js';
import { promisePool } from '../src/utils/promisePool.js';

import { createConfig } from './testConfig.js';

test('keeps the bundler pair for Vite-dependent packages', async () => {
  const compilerOptions = await generateCompilerOptionsFrom(
    { compilerOptions: { module: 'ESNext', moduleResolution: 'bundler' } },
    { vite: true }
  );
  expect(compilerOptions.moduleResolution).toBe('bundler');
  expect(compilerOptions.module).toBe('ESNext');
});

test('keeps an existing Preserve module kind for Vite-dependent packages', async () => {
  const compilerOptions = await generateCompilerOptionsFrom(
    { compilerOptions: { module: 'Preserve', moduleResolution: 'bundler' } },
    { vite: true }
  );
  expect(compilerOptions.module).toBe('Preserve');
  expect(compilerOptions.moduleResolution).toBe('bundler');
});

test('does not force a bundler resolver on Next configs that extend a base config', async () => {
  const extendedOptions = await generateCompilerOptionsFrom(
    { extends: '@tsconfig/node-lts/tsconfig.json', compilerOptions: {} },
    { next: true }
  );
  expect(extendedOptions.moduleResolution).toBeUndefined();

  const standaloneOptions = await generateCompilerOptionsFrom({ compilerOptions: {} }, { next: true });
  expect(standaloneOptions.moduleResolution).toBe('bundler');
});

test('drops removed node10 resolver spellings regardless of casing', async () => {
  const compilerOptions = await generateCompilerOptionsFrom({ compilerOptions: { moduleResolution: 'Node10' } });
  expect(compilerOptions.moduleResolution).toBeUndefined();
});

test('merges settings from a tsconfig containing JSONC comments instead of replacing the file', async () => {
  const compilerOptions = await generateCompilerOptionsFromContent(`{
  "compilerOptions": {
    // explains why the mapping exists
    "paths": {
      "undici-types": ["./node_modules/undici-types"]
    },
  }
}`);
  // The legacy package-directory mapping is normalized to the concrete index.d.ts file.
  expect(compilerOptions.paths).toEqual({ 'undici-types': ['./node_modules/undici-types/index.d.ts'] });
});

test('rewrites a stale wbfy-generated undici-types mapping to the current root depth', async () => {
  // An older getRootDir mis-resolved deep workspaces, so wbfy-generated mappings may carry a
  // wrong depth; they must be migrated to the depth the current getRootDir computes ('.' here).
  const compilerOptions = await generateCompilerOptionsFromContent(
    JSON.stringify({ compilerOptions: { paths: { 'undici-types': ['../../node_modules/undici-types/index.d.ts'] } } })
  );
  expect(compilerOptions.paths).toEqual({ 'undici-types': ['./node_modules/undici-types/index.d.ts'] });
});

test('keeps a deliberate repo-local undici-types mapping untouched', async () => {
  const compilerOptions = await generateCompilerOptionsFromContent(
    JSON.stringify({ compilerOptions: { paths: { 'undici-types': ['./patched-types/undici-types/index.d.ts'] } } })
  );
  expect(compilerOptions.paths).toEqual({ 'undici-types': ['./patched-types/undici-types/index.d.ts'] });
});

test('leaves an unparseable tsconfig untouched', async () => {
  const brokenContent = '{ "compilerOptions": { "paths": ';
  await withTempTsconfig(brokenContent, async (filePath, config) => {
    await generateTsconfig(config);
    await promisePool.promiseAll();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(brokenContent);
  });
});

test('initializes an empty tsconfig with the generated settings', async () => {
  await withTempTsconfig('', async (filePath, config) => {
    await generateTsconfig(config);
    await promisePool.promiseAll();
    const generated = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { compilerOptions?: object };
    expect(generated.compilerOptions).toBeDefined();
  });
});

test('leaves a tsconfig with an unterminated block comment untouched', async () => {
  const brokenContent = '/* unfinished';
  await withTempTsconfig(brokenContent, async (filePath, config) => {
    await generateTsconfig(config);
    await promisePool.promiseAll();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(brokenContent);
  });
});

test('does not write through a dangling tsconfig.json symlink', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-tsconfig-'));
  try {
    const targetPath = path.join(tempDirPath, 'outside.json');
    fs.symlinkSync(targetPath, path.join(tempDirPath, 'tsconfig.json'));
    const config = createConfig({ dirPath: tempDirPath, isRoot: true, doesContainTypeScript: true });
    await generateTsconfig(config);
    await promisePool.promiseAll();
    expect(fs.existsSync(targetPath)).toBe(false);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('initializes a comment-only tsconfig with the generated settings', async () => {
  await withTempTsconfig('// intentionally empty\n', async (filePath, config) => {
    await generateTsconfig(config);
    await promisePool.promiseAll();
    const generated = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { compilerOptions?: object };
    expect(generated.compilerOptions).toBeDefined();
  });
});

test('keeps a commented tsconfig byte-identical when the settings are already up to date', async () => {
  await withTempTsconfig('', async (filePath, config) => {
    await generateTsconfig(config);
    await promisePool.promiseAll();
    const commented = fs.readFileSync(filePath, 'utf8').replace('{\n', '{\n  // explains the setup\n');
    fs.writeFileSync(filePath, commented);
    await generateTsconfig(config);
    await promisePool.promiseAll();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(commented);
  });
});

test('merges settings from a tsconfig with a UTF-8 BOM instead of skipping it', async () => {
  const compilerOptions = await generateCompilerOptionsFromContent(
    '\uFEFF' + JSON.stringify({ compilerOptions: { paths: { 'undici-types': ['./node_modules/undici-types'] } } })
  );
  expect(compilerOptions.paths).toEqual({ 'undici-types': ['./node_modules/undici-types/index.d.ts'] });
});

test('keeps a nested workspace in the root project when its ancestor package is negated', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-tsconfig-'));
  try {
    // Bun 1.3.14 links only apps/web here (the package AT apps is negated), so the root tsconfig
    // must exclude apps' own sources without dropping apps/web/src (#1004).
    const workspaces = ['apps/**', '!apps'];
    fs.writeFileSync(
      path.join(tempDirPath, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces })
    );
    for (const workspaceDirName of ['apps', 'apps/web']) {
      const workspaceDirPath = path.join(tempDirPath, workspaceDirName);
      fs.mkdirSync(path.join(workspaceDirPath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspaceDirPath, 'package.json'), JSON.stringify({}));
      fs.writeFileSync(path.join(workspaceDirPath, 'src', 'index.ts'), 'export {};\n');
    }
    const config = createConfig({
      dirPath: tempDirPath,
      isRoot: true,
      doesContainSubPackageJsons: true,
      doesContainTypeScript: true,
      packageJson: { name: 'root', workspaces },
    });
    await generateTsconfig(config);
    await promisePool.promiseAll();
    const tsconfig = JSON.parse(fs.readFileSync(path.join(tempDirPath, 'tsconfig.json'), 'utf8')) as {
      exclude?: string[];
      include?: string[];
    };
    expect(tsconfig.include).toContain('apps/**/src/**/*');
    expect(tsconfig.exclude).not.toContain('apps');
    for (const excludeEntry of ['apps/*.config.ts', 'apps/scripts', 'apps/src', 'apps/test']) {
      expect(tsconfig.exclude).toContain(excludeEntry);
    }
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('excludes a framework workspace app directory from the root project but not a plain one', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-tsconfig-'));
  try {
    // A framework workspace (here vinext, the org's Next.js-equivalent) shims bare imports such as
    // `next/navigation` through its own tsconfig paths, so its app sources fail under the root
    // compiler options. A plain workspace's app directory carries no such requirement and must stay.
    const workspaces = ['e2e/fixture', 'packages/plain'];
    fs.writeFileSync(
      path.join(tempDirPath, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces })
    );
    for (const [workspaceDirName, dependencies] of [
      ['e2e/fixture', { vinext: '1.0.0' }],
      ['packages/plain', {}],
    ] as const) {
      const appDirPath = path.join(tempDirPath, workspaceDirName, 'app');
      fs.mkdirSync(appDirPath, { recursive: true });
      fs.writeFileSync(path.join(tempDirPath, workspaceDirName, 'package.json'), JSON.stringify({ dependencies }));
      fs.writeFileSync(path.join(appDirPath, 'page.tsx'), 'export default () => null;\n');
    }
    const config = createConfig({
      dirPath: tempDirPath,
      isRoot: true,
      doesContainSubPackageJsons: true,
      doesContainTypeScript: true,
      packageJson: { name: 'root', workspaces },
    });
    await generateTsconfig(config);
    await promisePool.promiseAll();
    const tsconfig = JSON.parse(fs.readFileSync(path.join(tempDirPath, 'tsconfig.json'), 'utf8')) as {
      exclude?: string[];
    };
    expect(tsconfig.exclude).toContain('e2e/fixture/app');
    expect(tsconfig.exclude).not.toContain('packages/plain/app');
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('keeps a commented Next tsconfig byte-identical when no cleanup is needed', async () => {
  const commentedContent = `{
  "compilerOptions": {
    // explains why the mapping exists
    "moduleResolution": "bundler",
    "paths": {
      "undici-types": ["./node_modules/undici-types/index.d.ts"]
    }
  }
}`;
  await withTempTsconfig(commentedContent, async (filePath, config) => {
    config.depending.next = true;
    await generateTsconfig(config);
    await promisePool.promiseAll();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(commentedContent);
  });
});

async function generateCompilerOptionsFrom(
  existingTsconfig: object,
  dependingOverrides: Partial<PackageConfig['depending']> = {}
): Promise<Record<string, unknown>> {
  return generateCompilerOptionsFromContent(JSON.stringify(existingTsconfig), dependingOverrides);
}

async function generateCompilerOptionsFromContent(
  existingContent: string,
  dependingOverrides: Partial<PackageConfig['depending']> = {}
): Promise<Record<string, unknown>> {
  return withTempTsconfig(existingContent, async (filePath, config) => {
    Object.assign(config.depending, dependingOverrides);
    await generateTsconfig(config);
    await promisePool.promiseAll();
    const generated = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      compilerOptions?: Record<string, unknown>;
    };
    return generated.compilerOptions ?? {};
  });
}

async function withTempTsconfig<T>(
  existingContent: string,
  runTest: (filePath: string, config: PackageConfig) => Promise<T>
): Promise<T> {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-tsconfig-'));
  try {
    const filePath = path.join(tempDirPath, 'tsconfig.json');
    fs.writeFileSync(filePath, existingContent);
    const config = createConfig({ dirPath: tempDirPath, isRoot: true, doesContainTypeScript: true });
    return await runTest(filePath, config);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
}
