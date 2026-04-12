import fs from 'node:fs';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { promisePool } from '../utils/promisePool.js';

export async function generateLintstagedrc(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateLintstagedrc', async () => {
    await Promise.all([
      promisePool.run(() => fs.promises.rm(`${config.dirPath}/.lintstagedrc.cjs`, { force: true })),
      promisePool.run(() => fs.promises.rm(`${config.dirPath}/.lintstagedrc.js`, { force: true })),
      promisePool.run(() => fs.promises.rm(`${config.dirPath}/.lintstagedrc.json`, { force: true })),
    ]);
  });
}
