import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { generateRepositoryNpmrc } from '../../src/generators/npmrc.js';
import type { PackageConfig } from '../../src/packageConfig.js';
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

  it.each(['WillBooster', 'WillBoosterLab'])(
    'generates only the non-secret private registry mapping for %s repositories that need it',
    async (repoAuthor) => {
      const rootDirPath = await makeTempDir();
      const workspaceDirPath = path.join(rootDirPath, 'packages', 'app');
      await fs.promises.mkdir(workspaceDirPath, { recursive: true });
      await fs.promises.writeFile(
        path.join(rootDirPath, 'package.json'),
        JSON.stringify({
          name: 'app',
          dependencies: { '@willbooster-private/shared': '1.0.0' },
        })
      );
      await fs.promises.writeFile(path.join(rootDirPath, '.npmrc'), '//example.test/:_authToken=secret\n');
      await fs.promises.writeFile(path.join(workspaceDirPath, '.npmrc'), 'registry=https://example.test/\n');
      fsUtil.setRootDirPath(rootDirPath);

      await generateRepositoryNpmrc([
        packageConfig(rootDirPath, repoAuthor, true),
        packageConfig(workspaceDirPath, repoAuthor, false),
      ]);

      expect(await fs.promises.readFile(path.join(rootDirPath, '.npmrc'), 'utf8')).toBe(
        '@willbooster-private:registry=https://verdaccio-production-e389.up.railway.app/\n'
      );
      expect(
        await fs.promises.lstat(path.join(workspaceDirPath, '.npmrc')).catch((error: unknown) => error)
      ).toMatchObject({ code: 'ENOENT' });
    }
  );

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
