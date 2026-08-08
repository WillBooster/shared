import fs from 'node:fs';
import path from 'node:path';

import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { privateRegistryScopeMapping, repoResolvesPrivatePackages } from '../utils/privatePackages.js';

/**
 * Bun reads registry scope mappings from a physical repository .npmrc during Renovate artifact
 * updates; Renovate's npmrc setting is used only by its datasource layer. Keep the non-secret
 * mapping in repositories that resolve private packages, while authentication remains in the
 * developer's ~/.npmrc locally and in temporary CI or Mend configuration.
 */
export async function generateRepositoryNpmrc(configs: PackageConfig[]): Promise<void> {
  const rootConfig = configs.find((config) => config.isRoot) ?? configs[0];
  if (rootConfig?.repoAuthor !== 'WillBooster' && rootConfig?.repoAuthor !== 'WillBoosterLab') return;

  const rootNpmrcPath = path.resolve(rootConfig.dirPath, '.npmrc');
  if (repoResolvesPrivatePackages(rootConfig)) {
    if (!(await fsUtil.generateFile(rootNpmrcPath, privateRegistryScopeMapping))) return;
  } else {
    await removeNpmrc(rootNpmrcPath);
  }

  for (const npmrcPath of new Set(configs.map((config) => path.resolve(config.dirPath, '.npmrc')))) {
    if (npmrcPath !== rootNpmrcPath) await removeNpmrc(npmrcPath);
  }
}

async function removeNpmrc(npmrcPath: string): Promise<void> {
  if (!(await fs.promises.lstat(npmrcPath).catch(() => {}))) return;
  if (await fsUtil.removeConfined(npmrcPath)) {
    console.info(`Removed non-canonical repository npmrc ${npmrcPath}.`);
  }
}
