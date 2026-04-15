import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

export async function generateOxlintConfig(config: PackageConfig, _rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxlintConfig', async () => {
    const shouldPreservePublishedEslintConfig = isWillboosterConfigsSubpackage(config);
    const filePath = path.resolve(config.dirPath, 'oxlint.config.ts');
    const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;

    const promises = [
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.oxlintrc.json'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'biome.json'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'biome.jsonc'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.cjs'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.js'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.json'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.yaml'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.yml'), { force: true })),
    ];
    if (!shouldPreservePublishedEslintConfig) {
      promises.push(
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.cjs'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.js'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.mjs'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.ts'), { force: true }))
      );
    }
    if (!existingContent) {
      promises.push(promisePool.run(() => fsUtil.generateFile(filePath, configContent)));
    }
    await Promise.all(promises);
  });
}

function isWillboosterConfigsSubpackage(config: PackageConfig): boolean {
  // willbooster-configs packages publish configuration files as product code.
  // Replacing their package-local ESLint configs with oxlint configs makes the
  // published package entry points disappear, so only this repository's
  // subpackages opt out. Other repositories keep the normal migration.
  return config.isWillBoosterConfigs && !config.isRoot;
}

const configContent = `import config from '@willbooster/oxlint-config';

export default config;
`;
