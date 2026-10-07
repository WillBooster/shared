import fs from 'node:fs';
import path from 'node:path';

import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { privateRegistryScopeMapping, repoResolvesPrivatePackages } from '../utils/privatePackages.js';

/**
 * Bun reads registry scope mappings from a physical repository .npmrc during Renovate artifact
 * updates; Renovate's npmrc setting is used only by its datasource layer. Keep the non-secret
 * mapping in repositories that resolve private packages, while authentication remains in the
 * developer's ~/.npmrc locally and in temporary CI or Mend configuration. Renovate writes
 * artifact credentials next to each package.json but runs Bun next to the root lockfile, so
 * workspace .npmrc symlinks route those temporary writes to the root.
 */
export async function generateRepositoryNpmrc(configs: PackageConfig[]): Promise<void> {
  const repoAuthor = configs[0]?.repoAuthor;
  if (repoAuthor !== 'WillBooster' && repoAuthor !== 'WillBoosterLab') return;

  const rootConfig = configs.find((config) => config.isRoot);
  if (!rootConfig) return;
  const npmrcPaths = new Set(configs.map((config) => path.resolve(config.dirPath, '.npmrc')));
  if (repoResolvesPrivatePackages(rootConfig)) {
    const rootNpmrcPath = path.resolve(rootConfig.dirPath, '.npmrc');
    npmrcPaths.delete(rootNpmrcPath);
    if (await fsUtil.generateFile(rootNpmrcPath, privateRegistryScopeMapping)) {
      for (const npmrcPath of npmrcPaths) {
        if (!(await fsUtil.removeConfined(npmrcPath))) continue;
        await fs.promises.symlink(path.relative(path.dirname(npmrcPath), rootNpmrcPath), npmrcPath);
        console.info(`Generated workspace npmrc link ${npmrcPath}.`);
      }
      return;
    }
  }

  for (const npmrcPath of npmrcPaths) await removeNpmrc(npmrcPath);
}

async function removeNpmrc(npmrcPath: string): Promise<void> {
  if (!(await fs.promises.lstat(npmrcPath).catch(() => {}))) return;
  if (await fsUtil.removeConfined(npmrcPath)) {
    console.info(`Removed non-canonical repository npmrc ${npmrcPath}.`);
  }
}
