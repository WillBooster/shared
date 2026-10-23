import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateTsconfig } from '../../src/generators/tsconfig.js';
import { getPackageConfig, type PackageConfig } from '../../src/packageConfig.js';
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
    // explains why the alias exists
    "paths": {
      "@/*": ["./src/*"]
    },
  }
}`);
  expect(compilerOptions.paths).toEqual({ '@/*': ['./src/*'] });
});

test.each(['generated', 'cleaned', 'local'] as const)(
  'isolates workspace declarations with %s aliases',
  async (aliasState) => {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-path-inheritance-'));
    try {
      const write = (filePath: string, content: string): void => {
        const absolutePath = path.join(dirPath, filePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content);
      };
      fs.symlinkSync(path.resolve(import.meta.dir, '../../node_modules'), path.join(dirPath, 'node_modules'));
      write('base.json', JSON.stringify({ compilerOptions: { paths: { sibling: ['./sibling/index.ts'] } } }));
      write('sibling/index.ts', 'export const value = 1;');
      write('workspace/src/local.ts', 'export const localValue = 1;');
      write(
        'workspace/src/index.ts',
        `export { value } from 'sibling';
import { version } from 'undici-types';
export const undiciVersion: string = version;
${aliasState === 'local' ? "export { localValue } from '@local';" : ''}`
      );
      write('legacy/node_modules/undici-types/index.d.ts', 'export declare const version: number;');
      write(
        'workspace/node_modules/undici-types/package.json',
        JSON.stringify({ name: 'undici-types', types: 'index.d.ts' })
      );
      write('workspace/node_modules/undici-types/index.d.ts', 'export declare const version: string;');
      write('workspace/node_modules/sibling/package.json', JSON.stringify({ name: 'sibling', types: 'index.d.ts' }));
      write('workspace/node_modules/sibling/index.d.ts', 'export declare const value: number;');
      write(
        'workspace/tsconfig.json',
        JSON.stringify({
          extends: '../base.json',
          compilerOptions:
            aliasState === 'cleaned'
              ? {}
              : {
                  paths: {
                    'undici-types': ['../legacy/node_modules/undici-types/index.d.ts'],
                    ...(aliasState === 'local' ? { '@local': ['./src/local.ts'] } : {}),
                  },
                },
        })
      );
      await generateTsconfig(createConfig({ dirPath: path.join(dirPath, 'workspace'), doesContainTypeScript: true }));
      write(
        'workspace/tsconfig.build.json',
        JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            noEmit: false,
            emitDeclarationOnly: true,
            declaration: true,
            rootDir: 'src',
            outDir: 'dist',
          },
          include: ['src/**/*'],
        })
      );
      const child = Bun.spawn(
        [
          'bun',
          path.resolve(import.meta.dir, '../../node_modules/typescript/bin/tsc'),
          '-p',
          path.join(dirPath, 'workspace/tsconfig.build.json'),
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, output: stdout + stderr }).toEqual({ exitCode: 0, output: '' });
      expect(fs.readFileSync(path.join(dirPath, 'workspace/dist/index.d.ts'), 'utf8')).toContain("from 'sibling'");
    } finally {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  }
);

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
    '\uFEFF' + JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } })
  );
  expect(compilerOptions.paths).toEqual({ '@/*': ['./src/*'] });
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

test('excludes framework workspace app and src/app directories from the root project but not a plain one', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-tsconfig-'));
  try {
    // A framework workspace (here vinext, the org's Next.js-equivalent) shims bare imports such as
    // `next/navigation` through its own tsconfig paths, so its app sources fail under the root
    // compiler options. A plain workspace's app directory carries no such requirement and must stay.
    const workspaces = ['e2e/fixture', 'apps/src-layout', 'packages/plain', 'packages/broken'];
    fs.writeFileSync(
      path.join(tempDirPath, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces })
    );
    for (const [workspaceDirName, appDirName, manifest] of [
      ['e2e/fixture', 'app', JSON.stringify({ dependencies: { vinext: '1.0.0' } })],
      // The src-directory layout keeps the framework app under src/app, which the root project's
      // managed `src/**/*` include would otherwise pull in.
      ['apps/src-layout', 'src/app', JSON.stringify({ dependencies: { next: '15.0.0' } })],
      ['packages/plain', 'app', JSON.stringify({ dependencies: {} })],
      // A manifest that parses to a non-object must not crash framework detection.
      ['packages/broken', 'app', 'null'],
    ] as const) {
      const appDirPath = path.join(tempDirPath, workspaceDirName, appDirName);
      fs.mkdirSync(appDirPath, { recursive: true });
      fs.writeFileSync(path.join(tempDirPath, workspaceDirName, 'package.json'), manifest);
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
    const tsconfig = JSON.parse(fs.readFileSync(path.join(tempDirPath, 'tsconfig.json'), 'utf8')) as {
      exclude?: string[];
    };
    expect(tsconfig.exclude).toContain('e2e/fixture/app');
    expect(tsconfig.exclude).toContain('apps/src-layout/src/app');
    expect(tsconfig.exclude).not.toContain('packages/plain/app');
    expect(tsconfig.exclude).not.toContain('packages/broken/app');
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('prunes a stale framework app exclude after its workspace is removed', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-tsconfig-'));
  try {
    const appDirPath = path.join(tempDirPath, 'apps/web/app');
    fs.mkdirSync(appDirPath, { recursive: true });
    fs.writeFileSync(path.join(tempDirPath, 'apps/web/package.json'), JSON.stringify({ dependencies: { next: '15' } }));
    fs.writeFileSync(path.join(appDirPath, 'page.tsx'), 'export default () => null;\n');
    fs.mkdirSync(path.join(tempDirPath, 'packages/plain/src'), { recursive: true });
    fs.writeFileSync(path.join(tempDirPath, 'packages/plain/package.json'), JSON.stringify({}));

    const generateWith = async (workspaces: string[]): Promise<string[]> => {
      fs.writeFileSync(
        path.join(tempDirPath, 'package.json'),
        JSON.stringify({ name: 'root', private: true, workspaces })
      );
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
      };
      return tsconfig.exclude ?? [];
    };

    expect(await generateWith(['apps/web', 'packages/plain'])).toContain('apps/web/app');
    // Removing apps/web from the workspaces makes its managed includes stale, so its now-orphaned
    // app exclude must not survive into the regenerated root tsconfig.
    expect(await generateWith(['packages/plain'])).not.toContain('apps/web/app');
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('keeps root and workspace compiler scopes separate while preserving coverage for roots without src', async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-root-scope-'));
  try {
    const write = (filePath: string, content: string): void => {
      const absolutePath = path.join(dirPath, filePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content);
    };
    const packageJson = {
      name: 'scope-root',
      private: true,
      type: 'module',
      packageManager: `bun@${Bun.version}`,
      workspaces: ['packages/*'],
      scripts: { typecheck: 'bun wb typecheck' },
      devDependencies: { '@willbooster/wb': '*', oxlint: '*', 'oxlint-tsgolint': '*' },
    } satisfies NonNullable<PackageConfig['packageJson']>;
    write('package.json', JSON.stringify(packageJson));
    write('.gitignore', 'node_modules/\n');
    write('.oxlintrc.json', JSON.stringify({ ignorePatterns: ['node_modules/**'] }));
    fs.symlinkSync(path.resolve(import.meta.dir, '../../../../node_modules'), path.join(dirPath, 'node_modules'));
    write('src/root.ts', 'export const root: number = 1;');
    write('tool.config.ts', 'export const tool: number = 1;');
    for (const name of ['web', 'cli']) {
      const alias = name === 'web' ? '@' : '@cli';
      write(
        `packages/${name}/package.json`,
        JSON.stringify({
          name: `scope-${name}`,
          type: 'module',
          scripts: { typecheck: 'bun wb typecheck' },
          ...(name === 'web' ? { dependencies: { next: '*' } } : {}),
        })
      );
      write(
        `packages/${name}/src/value.ts`,
        name === 'web' ? 'export const value = window.location.href;' : 'export const value: number = 1;'
      );
      write(`packages/${name}/src/index.ts`, `export { value } from '${alias}/value';`);
      write(
        `packages/${name}/tsconfig.json`,
        JSON.stringify({
          compilerOptions: {
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            target: 'ESNext',
            module: 'Preserve',
            moduleResolution: 'bundler',
            lib: name === 'web' ? ['ESNext', 'DOM'] : ['ESNext'],
            paths: { [`${alias}/*`]: ['./src/*'] },
          },
          include: ['src/**/*'],
        })
      );
    }
    const generateRootConfig = async (): Promise<void> => {
      const config = await getPackageConfig(dirPath, { isRoot: true });
      assert.ok(config);
      await generateTsconfig(config);
    };
    await generateRootConfig();
    expect(await runTypecheck(dirPath)).toMatchObject({ exitCode: 0 });

    write(
      'tsconfig.json',
      JSON.stringify({
        include: ['**/*.ts'],
        exclude: ['node_modules', 'packages', 'test/fixtures'],
      })
    );
    await generateRootConfig();
    expect(await runTypecheck(dirPath)).toMatchObject({ exitCode: 0 });
    write('src/root.ts', 'export const root: number = "wrong";');
    const brokenRoot = await runTypecheck(dirPath);
    expect(brokenRoot.exitCode).toBe(1);
    expect(brokenRoot.output).toContain('src/root.ts');
    write('src/root.ts', 'export const root: number = 1;');
    write('packages/cli/src/value.ts', 'export const value: number = "wrong";');
    const brokenWorkspace = await runTypecheck(dirPath);
    expect(brokenWorkspace.exitCode).toBe(1);
    expect(brokenWorkspace.output).toContain('src/value.ts');
    write('packages/cli/src/value.ts', 'export const value: number = 1;');

    fs.rmSync(path.join(dirPath, 'src'), { recursive: true });
    write('packages/legacy/package.json', JSON.stringify({ name: 'scope-legacy', type: 'module' }));
    write('packages/legacy/src/value.ts', 'export const value = Bun.version;');
    write('packages/legacy/src/index.ts', "export { value } from '@fixture/value';");
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { paths: { '@fixture/*': ['./packages/legacy/src/*'] } },
      })
    );
    await generateRootConfig();
    expect(await runTypecheck(dirPath)).toMatchObject({ exitCode: 0 });
    write('packages/legacy/src/value.ts', 'export const value: number = "wrong";');
    const brokenFallback = await runTypecheck(dirPath);
    expect(brokenFallback.exitCode).toBe(1);
    expect(brokenFallback.output).toContain('packages/legacy/src/value.ts');
  } finally {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}, 30_000);

test('keeps a commented Next tsconfig byte-identical when no cleanup is needed', async () => {
  const commentedContent = `{
  "compilerOptions": {
    // explains why the alias exists
    "moduleResolution": "bundler",
    "paths": {
      "@/*": ["./src/*"]
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

async function runTypecheck(dirPath: string): Promise<{ exitCode: number; output: string }> {
  const cliPath = path.resolve(import.meta.dir, '../../../wb/src/index.ts');
  const child = Bun.spawn(['bun', cliPath, '--working-dir', dirPath, 'typecheck'], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}
