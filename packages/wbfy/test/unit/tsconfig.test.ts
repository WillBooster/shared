import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { generateTsconfig } from '../../src/generators/tsconfig.js';
import type { PackageConfig } from '../../src/packageConfig.js';

import { createConfig } from '../helpers/testConfig.js';

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

test('merges settings from a tsconfig containing JSONC comments instead of replacing the file', async () => {
  const compilerOptions = await generateCompilerOptionsFromContent(`{
  "compilerOptions": {
    // explains why the mapping exists
    "paths": {
      "undici-types": ["./node_modules/undici-types/index.d.ts"]
    },
  }
}`);
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
    expect(fs.readFileSync(filePath, 'utf8')).toBe(brokenContent);
  });
});

test('initializes an empty tsconfig with the generated settings', async () => {
  await withTempTsconfig('', async (filePath, config) => {
    await generateTsconfig(config);
    const generated = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { compilerOptions?: object };
    expect(generated.compilerOptions).toBeDefined();
  });
});

test('leaves a tsconfig with an unterminated block comment untouched', async () => {
  const brokenContent = '/* unfinished';
  await withTempTsconfig(brokenContent, async (filePath, config) => {
    await generateTsconfig(config);
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
    expect(fs.existsSync(targetPath)).toBe(false);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('initializes a comment-only tsconfig with the generated settings', async () => {
  await withTempTsconfig('// intentionally empty\n', async (filePath, config) => {
    await generateTsconfig(config);
    const generated = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { compilerOptions?: object };
    expect(generated.compilerOptions).toBeDefined();
  });
});

test('keeps a commented tsconfig byte-identical when the settings are already up to date', async () => {
  await withTempTsconfig('', async (filePath, config) => {
    await generateTsconfig(config);
    const commented = fs.readFileSync(filePath, 'utf8').replace('{\n', '{\n  // explains the setup\n');
    fs.writeFileSync(filePath, commented);
    await generateTsconfig(config);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(commented);
  });
});

test('merges settings from a tsconfig with a UTF-8 BOM instead of skipping it', async () => {
  const compilerOptions = await generateCompilerOptionsFromContent(
    '\uFEFF' +
      JSON.stringify({ compilerOptions: { paths: { 'undici-types': ['./node_modules/undici-types/index.d.ts'] } } })
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

test('checks framework helpers under their workspace config while retaining plain workspace checks', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-tsconfig-'));
  try {
    fs.mkdirSync(path.join(tempDirPath, 'src'));
    fs.writeFileSync(path.join(tempDirPath, 'src/index.ts'), 'export {};');
    const workspaces = ['apps/web', 'apps/web/plugins/plain'];
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), JSON.stringify({ private: true, workspaces }));
    fs.symlinkSync(path.resolve(import.meta.dir, '../../node_modules'), path.join(tempDirPath, 'node_modules'));
    for (const workspace of ['web', 'web/plugins/plain']) {
      fs.mkdirSync(path.join(tempDirPath, 'apps', workspace, 'src'), { recursive: true });
    }
    fs.writeFileSync(path.join(tempDirPath, 'tsconfig.json'), JSON.stringify({ include: ['apps/**/*'] }));
    const webDirPath = path.join(tempDirPath, 'apps/web');
    fs.writeFileSync(path.join(webDirPath, 'package.json'), JSON.stringify({ dependencies: { vinext: '1' } }));
    fs.writeFileSync(path.join(webDirPath, 'src/value.ts'), 'export const value = window.location.href;');
    fs.writeFileSync(path.join(webDirPath, 'src/helper.ts'), "export { value } from '@/value';");
    fs.writeFileSync(
      path.join(webDirPath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { noEmit: true, lib: ['ESNext', 'DOM'], paths: { '@/*': ['./src/*'] } },
        include: ['src/**/*'],
      })
    );
    const plainSourcePath = path.join(tempDirPath, 'apps/web/plugins/plain/src/index.ts');
    fs.writeFileSync(path.join(tempDirPath, 'apps/web/plugins/plain/package.json'), '{}');
    fs.writeFileSync(plainSourcePath, 'export const value: number = 1;');
    const config = createConfig({
      dirPath: tempDirPath,
      isRoot: true,
      doesContainSubPackageJsons: true,
      doesContainTypeScript: true,
      packageJson: { workspaces },
    });
    await generateTsconfig(config);
    const firstConfig = fs.readFileSync(path.join(tempDirPath, 'tsconfig.json'), 'utf8');
    await generateTsconfig(config);
    expect(fs.readFileSync(path.join(tempDirPath, 'tsconfig.json'), 'utf8')).toBe(firstConfig);
    expect(await check(tempDirPath)).toMatchObject({ exitCode: 0 });
    expect(await check(webDirPath)).toMatchObject({ exitCode: 0 });
    fs.writeFileSync(plainSourcePath, 'export const value: number = "wrong";');
    const brokenPlain = await check(tempDirPath);
    expect(brokenPlain.exitCode).toBe(1);
    expect(brokenPlain.output).toContain('apps/web/plugins/plain/src/index.ts');
    fs.mkdirSync(path.join(webDirPath, 'test/unit'), { recursive: true });
    const testSourcePath = path.join(webDirPath, 'test/unit/example.test.ts');
    const toolSourcePath = path.join(webDirPath, 'playwright.config.ts');
    fs.writeFileSync(testSourcePath, 'export const bad: number = "wrong";');
    fs.writeFileSync(toolSourcePath, 'export const bad: number = "wrong";');
    await generateTsconfig(
      createConfig({
        dirPath: webDirPath,
        depending: { ...config.depending, vinext: true },
      })
    );
    const frameworkTools = await check(webDirPath);
    expect(frameworkTools.exitCode).toBe(1);
    expect(frameworkTools.output).toContain('test/unit/example.test.ts');
    expect(frameworkTools.output).toContain('playwright.config.ts');
    fs.rmSync(testSourcePath);
    fs.rmSync(toolSourcePath);
    fs.writeFileSync(path.join(webDirPath, 'src/value.ts'), 'export const value: number = "wrong";');
    const brokenWeb = await check(webDirPath);
    expect(brokenWeb.exitCode).toBe(1);
    // Once the web directory stops being a workspace, the repository's broad include owns it.
    fs.writeFileSync(plainSourcePath, 'export const value: number = 1;');
    fs.writeFileSync(path.join(webDirPath, 'src/helper.ts'), 'export {};');
    const remainingWorkspaces = ['apps/web/plugins/plain'];
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), JSON.stringify({ workspaces: remainingWorkspaces }));
    config.packageJson = { workspaces: remainingWorkspaces };
    await generateTsconfig(config);
    const removedWorkspace = await check(tempDirPath);
    expect(removedWorkspace.exitCode).toBe(1);
    expect(removedWorkspace.output).toContain('apps/web/src/value.ts');
    const globWorkspaces = ['apps/*', 'apps/web/plugins/plain'];
    config.packageJson = { workspaces: globWorkspaces };
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), JSON.stringify({ workspaces: globWorkspaces }));
    await generateTsconfig(config);
    const restoredFramework = await check(tempDirPath);
    expect(restoredFramework.exitCode).toBe(0);
    fs.unlinkSync(path.join(webDirPath, 'package.json'));
    await generateTsconfig(config);
    const removedManifest = await check(tempDirPath);
    expect(removedManifest.exitCode).toBe(1);
    expect(removedManifest.output).toContain('apps/web/src/value.ts');
    const baselineWorkspaces = ['!other/**'];
    config.packageJson = { workspaces: baselineWorkspaces };
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), JSON.stringify({ workspaces: baselineWorkspaces }));
    fs.writeFileSync(path.join(webDirPath, 'package.json'), JSON.stringify({ dependencies: { vinext: '1' } }));
    await generateTsconfig(config);
    const baselineFramework = await check(tempDirPath);
    expect(baselineFramework.exitCode).toBe(0);
    fs.unlinkSync(path.join(webDirPath, 'package.json'));
    await generateTsconfig(config);
    const baselineRemovedManifest = await check(tempDirPath);
    expect(baselineRemovedManifest.exitCode).toBe(1);
    expect(baselineRemovedManifest.output).toContain('apps/web/src/value.ts');
    fs.writeFileSync(path.join(webDirPath, 'src/value.ts'), 'export const value: number = 1;');
    fs.mkdirSync(path.join(tempDirPath, 'dist/src'), { recursive: true });
    fs.writeFileSync(path.join(tempDirPath, 'dist/src/stale.ts'), 'export const stale: number = "wrong";');
    fs.writeFileSync(path.join(tempDirPath, 'tsconfig.json'), JSON.stringify({ exclude: ['node_modules', 'dist'] }));
    for (const layout of [['!apps/**'], ['apps/*']]) {
      config.packageJson = { workspaces: layout };
      fs.writeFileSync(path.join(tempDirPath, 'package.json'), JSON.stringify({ workspaces: layout }));
      await generateTsconfig(config);
      const ignoredBuildOutput = await check(tempDirPath);
      expect(ignoredBuildOutput).toMatchObject({ exitCode: 0 });
    }
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

async function check(project: string): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn(['bun', 'check', '-p', project], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}
