import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { getWorkspaceSubDirPaths } from '../src/utils/workspaceUtil.js';
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
