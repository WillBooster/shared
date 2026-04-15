import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

export async function generateOxlintConfig(config: PackageConfig, rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxlintConfig', async () => {
    const configPath = path.relative(
      config.dirPath,
      path.resolve(rootConfig.dirPath, 'node_modules', '@willbooster', 'oxlint-config', '.oxlintrc.json')
    );
    const newSettings: object = {
      extends: [configPath.startsWith('.') ? configPath : `./${configPath}`],
    };
    const filePath = path.resolve(config.dirPath, '.oxlintrc.json');

    await Promise.all([
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'biome.jsonc'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.mjs'), { force: true })),
      promisePool.run(() => fsUtil.generateFile(filePath, JSON.stringify(newSettings, undefined, 2))),
    ]);
  });
}
