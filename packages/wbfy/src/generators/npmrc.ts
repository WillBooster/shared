import fs from 'node:fs';
import path from 'node:path';

import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';

/**
 * Organization repositories authenticate local package-manager commands exclusively through the
 * developer's ~/.npmrc. CI may create a temporary repository .npmrc, but it must never become
 * persistent repository configuration.
 */
export async function removeRepositoryNpmrcFiles(configs: PackageConfig[]): Promise<void> {
  const rootConfig = configs.find((config) => config.isRoot) ?? configs[0];
  if (rootConfig?.repoAuthor !== 'WillBooster' && rootConfig?.repoAuthor !== 'WillBoosterLab') return;

  for (const npmrcPath of new Set(configs.map((config) => path.resolve(config.dirPath, '.npmrc')))) {
    if (!(await fs.promises.lstat(npmrcPath).catch(() => {}))) continue;
    if (await fsUtil.removeConfined(npmrcPath)) {
      console.info(`Removed repository npmrc ${npmrcPath}; local authentication belongs in ~/.npmrc.`);
    }
  }
}
