import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { generateRepositoryNpmrc } from '../../src/generators/npmrc.js';
import { getPackageConfig, type PackageConfig } from '../../src/packageConfig.js';
import { fsUtil } from '../../src/utils/fsUtil.js';

const tempDirPaths: string[] = [];

afterEach(async () => {
  fsUtil.setRootDirPath(undefined);
  await Promise.all(tempDirPaths.splice(0).map((dirPath) => fs.promises.rm(dirPath, { recursive: true, force: true })));
});

describe('generateRepositoryNpmrc', () => {
  it.each(['WillBooster', 'WillBoosterLab'])('removes root and workspace npmrc files for %s', async (repoAuthor) => {
    const rootDirPath = await makeTempDir();
    const workspaceDirPath = path.join(rootDirPath, 'packages', 'app');
    await fs.promises.mkdir(workspaceDirPath, { recursive: true });
    await fs.promises.writeFile(path.join(rootDirPath, '.npmrc'), 'root=true\n');
    await fs.promises.symlink('../../.npmrc', path.join(workspaceDirPath, '.npmrc'));
    fsUtil.setRootDirPath(rootDirPath);

    await generateRepositoryNpmrc([
      packageConfig(rootDirPath, repoAuthor, true),
      packageConfig(workspaceDirPath, repoAuthor, false),
    ]);

    expect(await fs.promises.lstat(path.join(rootDirPath, '.npmrc')).catch((error: unknown) => error)).toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await fs.promises.lstat(path.join(workspaceDirPath, '.npmrc')).catch((error: unknown) => error)
    ).toMatchObject({ code: 'ENOENT' });
  });

  it('routes temporary workspace authentication to the root and regenerates links without retaining credentials', async () => {
    const rootDirPath = await makeTempDir();
    const workspaceDirPath = path.join(rootDirPath, 'apps', 'nested', 'app');
    await fs.promises.mkdir(workspaceDirPath, { recursive: true });
    await fs.promises.writeFile(
      path.join(rootDirPath, 'package.json'),
      JSON.stringify({ name: 'app', repository: 'github:WillBooster/shared', workspaces: ['apps/nested/*'] })
    );
    await fs.promises.writeFile(
      path.join(workspaceDirPath, 'package.json'),
      JSON.stringify({ name: 'workspace', dependencies: { '@willbooster-private/shared': '1.0.0' } })
    );
    const rootConfig = await getPackageConfig(rootDirPath, { isRoot: true });
    const workspaceConfig = await getPackageConfig(workspaceDirPath, { isRoot: false });
    if (!rootConfig || !workspaceConfig) throw new Error('Failed to load fixture manifests');
    fsUtil.setRootDirPath(rootDirPath);
    const rootNpmrcPath = path.join(rootDirPath, '.npmrc');
    const workspaceNpmrcPath = path.join(workspaceDirPath, '.npmrc');
    await fs.promises.writeFile(workspaceNpmrcPath, 'registry=https://example.test/\n');

    await generateRepositoryNpmrc([rootConfig, workspaceConfig]);
    const originalContent = await fs.promises.readFile(rootNpmrcPath, 'utf8');
    await fs.promises.appendFile(workspaceNpmrcPath, '//example.test/:_authToken=temporary\n');
    expect(await fs.promises.readFile(rootNpmrcPath, 'utf8')).toContain('_authToken=temporary');

    await generateRepositoryNpmrc([rootConfig, workspaceConfig]);
    expect(await fs.promises.readFile(rootNpmrcPath, 'utf8')).toBe(originalContent);
    await fs.promises.appendFile(workspaceNpmrcPath, '//example.test/:_authToken=second\n');
    expect(await fs.promises.readFile(rootNpmrcPath, 'utf8')).toContain('_authToken=second');
  });

  it('does not treat a directly targeted workspace as the repository root', async () => {
    const workspaceDirPath = await makeTempDir();
    const npmrcPath = path.join(workspaceDirPath, '.npmrc');
    await fs.promises.writeFile(
      path.join(workspaceDirPath, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: { '@willbooster-private/shared': '1.0.0' },
      })
    );
    await fs.promises.writeFile(npmrcPath, 'registry=https://example.test/\n');
    fsUtil.setRootDirPath(workspaceDirPath);

    await generateRepositoryNpmrc([packageConfig(workspaceDirPath, 'WillBooster', false)]);

    expect(await fs.promises.lstat(npmrcPath).catch((error: unknown) => error)).toMatchObject({ code: 'ENOENT' });
  });

  it('preserves repository npmrc files outside the organizations', async () => {
    const rootDirPath = await makeTempDir();
    const npmrcPath = path.join(rootDirPath, '.npmrc');
    await fs.promises.writeFile(npmrcPath, 'registry=https://example.test/\n');
    fsUtil.setRootDirPath(rootDirPath);

    await generateRepositoryNpmrc([packageConfig(rootDirPath, 'example', true)]);

    expect(await fs.promises.readFile(npmrcPath, 'utf8')).toBe('registry=https://example.test/\n');
  });
});

async function makeTempDir(): Promise<string> {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wbfy-npmrc-'));
  tempDirPaths.push(dirPath);
  return dirPath;
}

function packageConfig(dirPath: string, repoAuthor: string, isRoot: boolean): PackageConfig {
  return { dirPath, repoAuthor, isRoot } as PackageConfig;
}
