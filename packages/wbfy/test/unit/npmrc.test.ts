import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { removeRepositoryNpmrcFiles } from '../../src/generators/npmrc.js';
import type { PackageConfig } from '../../src/packageConfig.js';
import { fsUtil } from '../../src/utils/fsUtil.js';

const tempDirPaths: string[] = [];

afterEach(async () => {
  fsUtil.setRootDirPath(undefined);
  await Promise.all(tempDirPaths.splice(0).map((dirPath) => fs.promises.rm(dirPath, { recursive: true, force: true })));
});

describe('removeRepositoryNpmrcFiles', () => {
  it.each(['WillBooster', 'WillBoosterLab'])('removes root and workspace npmrc files for %s', async (repoAuthor) => {
    const rootDirPath = await makeTempDir();
    const workspaceDirPath = path.join(rootDirPath, 'packages', 'app');
    await fs.promises.mkdir(workspaceDirPath, { recursive: true });
    await fs.promises.writeFile(path.join(rootDirPath, '.npmrc'), 'root=true\n');
    await fs.promises.symlink('../../.npmrc', path.join(workspaceDirPath, '.npmrc'));
    fsUtil.setRootDirPath(rootDirPath);

    await removeRepositoryNpmrcFiles([
      packageConfig(rootDirPath, repoAuthor, true),
      packageConfig(workspaceDirPath, repoAuthor, false),
    ]);

    await expect(fs.promises.lstat(path.join(rootDirPath, '.npmrc'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.lstat(path.join(workspaceDirPath, '.npmrc'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves repository npmrc files outside the organizations', async () => {
    const rootDirPath = await makeTempDir();
    const npmrcPath = path.join(rootDirPath, '.npmrc');
    await fs.promises.writeFile(npmrcPath, 'registry=https://example.test/\n');
    fsUtil.setRootDirPath(rootDirPath);

    await removeRepositoryNpmrcFiles([packageConfig(rootDirPath, 'example', true)]);

    await expect(fs.promises.readFile(npmrcPath, 'utf8')).resolves.toBe('registry=https://example.test/\n');
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
