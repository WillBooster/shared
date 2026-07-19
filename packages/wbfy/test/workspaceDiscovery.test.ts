import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { getWorkspaceDirPatterns, getWorkspaceSubDirPaths } from '../src/utils/workspaceUtil.js';
import { generateTsconfig } from '../src/generators/tsconfig.js';
import { getPackageConfig } from '../src/packageConfig.js';
import { promisePool } from '../src/utils/promisePool.js';

test('discovers and manages workspaces declared outside packages/* (e.g. apps/*)', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-workspaces-'));
  try {
    fs.writeFileSync(
      path.join(tempDirPath, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['apps/*', 'packages/*'] })
    );
    const appDirPath = path.join(tempDirPath, 'apps', 'web');
    fs.mkdirSync(path.join(appDirPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(appDirPath, 'package.json'), JSON.stringify({ name: 'web' }));
    fs.writeFileSync(path.join(appDirPath, 'src', 'index.ts'), 'export {};\n');

    const subDirPaths = getWorkspaceSubDirPaths({
      dirPath: tempDirPath,
      doesContainSubPackageJsons: false,
      packageJson: { workspaces: ['apps/*', 'packages/*'] },
    });
    expect(subDirPaths).toEqual([appDirPath]);

    // apps/* workspaces are classified as child packages, not roots.
    const config = await getPackageConfig(appDirPath, { isRoot: false });
    expect(config).toBeDefined();
    expect(config?.isRoot).toBe(false);
    expect(config?.doesContainTypeScript).toBe(true);

    // …and therefore receive managed settings such as tsconfig.json.
    if (!config) throw new Error('unreachable');
    await generateTsconfig(config);
    await promisePool.promiseAll();
    const tsconfig = JSON.parse(fs.readFileSync(path.join(appDirPath, 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: object;
    };
    expect(tsconfig.compilerOptions).toBeDefined();
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('derives root signals and root tsconfig coverage from an apps/*-only monorepo', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-workspaces-'));
  try {
    fs.writeFileSync(
      path.join(tempDirPath, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*'] })
    );
    const appDirPath = path.join(tempDirPath, 'apps', 'web');
    fs.mkdirSync(path.join(appDirPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(appDirPath, 'package.json'), JSON.stringify({ name: 'web' }));
    fs.writeFileSync(path.join(appDirPath, 'src', 'App.tsx'), 'export {};\n');

    // isRoot: false skips the network-touching repository lookup; the signals below are computed
    // the same way for roots.
    const config = await getPackageConfig(tempDirPath, { isRoot: false });
    if (!config) throw new Error('unreachable');
    expect(config.doesContainSubPackageJsons).toBe(true);
    expect(config.doesContainTypeScriptInPackages).toBe(true);
    expect(config.doesContainJsxOrTsxInPackages).toBe(true);
    expect(config.doesContainJavaScriptInPackages).toBe(false);

    config.isRoot = true;
    await generateTsconfig(config);
    await promisePool.promiseAll();
    const tsconfig = JSON.parse(fs.readFileSync(path.join(tempDirPath, 'tsconfig.json'), 'utf8')) as {
      exclude?: string[];
      include?: string[];
    };
    // Exact arrays: the never-matching packages/* fallback must not leak into apps/*-only output.
    expect(tsconfig.include).toEqual([
      '*.config.ts',
      'apps/*/*.config.ts',
      'apps/*/scripts/**/*',
      'apps/*/src/**/*',
      'apps/*/test/**/*',
      'scripts/**/*',
      'src/**/*',
      'test/**/*',
    ]);
    expect(tsconfig.exclude).toEqual(['apps/*/test/fixtures', 'test/fixtures']);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('translates Bun-only workspace glob syntax and negations into tsconfig-safe patterns', () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-workspaces-'));
  try {
    for (const workspaceDirName of ['apps/web', 'apps/excluded', 'tools/cli']) {
      const workspaceDirPath = path.join(tempDirPath, workspaceDirName);
      fs.mkdirSync(workspaceDirPath, { recursive: true });
      fs.writeFileSync(path.join(workspaceDirPath, 'package.json'), JSON.stringify({}));
    }
    // Trailing slash must not double separators; braces (Bun-only glob syntax, invalid in
    // tsconfig include) must expand to concrete directories; negations must become excludes.
    const workspaces = ['apps/*/', '!apps/excluded', '{tools,services}/*'];
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), JSON.stringify({ name: 'root', workspaces }));
    expect(
      getWorkspaceDirPatterns({ dirPath: tempDirPath, doesContainSubPackageJsons: true, packageJson: { workspaces } })
    ).toEqual({ excludes: ['apps/excluded'], includes: ['apps/*', 'tools/cli'] });
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('ignores workspace patterns escaping the repository', () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-workspaces-'));
  try {
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), JSON.stringify({ workspaces: ['../outside/*'] }));
    expect(
      getWorkspaceSubDirPaths({
        dirPath: tempDirPath,
        doesContainSubPackageJsons: false,
        packageJson: { workspaces: ['../outside/*'] },
      })
    ).toEqual([]);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});
