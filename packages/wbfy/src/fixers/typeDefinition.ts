import fs from 'node:fs/promises';
import path from 'node:path';

import { ignoreEnoentAsync } from '@willbooster/shared-lib';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { promisePool } from '../utils/promisePool.js';

export async function fixTypeDefinitions(
  config: PackageConfig,
  configsIncludingChildren: PackageConfig[]
): Promise<void> {
  return logger.functionIgnoringException('fixTypeDefinitions', async () => {
    const libTypeDirPath = path.resolve(config.dirPath, '@types');
    const srcTypeDirPath =
      config.isRoot && config.doesContainSubPackageJsons ? undefined : path.resolve(config.dirPath, 'src', 'types');

    const dirents = await ignoreEnoentAsync(() => fs.readdir(libTypeDirPath, { withFileTypes: true }));
    if (!dirents) return;

    for (const dirent of dirents) {
      const dirName = dirent.name.slice(0, -5);
      const hasTypeDeclarationExtension = dirent.name.endsWith('.d.ts');
      let packageName = hasTypeDeclarationExtension ? dirName : dirent.name;
      if (packageName.includes('__')) {
        packageName = `@${packageName.replace('__', '/')}`;
      }
      const hasLibrary = configsIncludingChildren.some(
        (config) =>
          config.packageJson?.dependencies?.[packageName] || config.packageJson?.devDependencies?.[packageName]
      );

      if (dirent.isFile() && hasTypeDeclarationExtension) {
        if (hasLibrary) {
          // Move @types/<name>/index.d.ts if installed
          await fs.mkdir(path.join(libTypeDirPath, dirName));
          await promisePool.run(() =>
            fs.rename(path.join(libTypeDirPath, dirent.name), path.join(libTypeDirPath, dirName, 'index.d.ts'))
          );
        } else if (srcTypeDirPath) {
          // Move src/types/<name> if not installed
          await fs.mkdir(srcTypeDirPath, { recursive: true });
          await promisePool.run(() =>
            fs.rename(path.join(libTypeDirPath, dirent.name), path.join(srcTypeDirPath, dirent.name))
          );
        }
      } else if (dirent.isDirectory() && srcTypeDirPath && !hasLibrary) {
        // Move src/types/<name>.d.ts if not installed
        await fs.mkdir(srcTypeDirPath, { recursive: true });
        await promisePool.run(() =>
          ignoreEnoentAsync(() =>
            fs.rename(
              path.join(libTypeDirPath, dirent.name, 'index.d.ts'),
              path.join(srcTypeDirPath, `${dirent.name}.d.ts`)
            )
          )
        );
      }
    }
  });
}
