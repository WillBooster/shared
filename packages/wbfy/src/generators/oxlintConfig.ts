import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { isPublishedWillboosterConfigsPackage } from '../utils/willboosterConfigsUtil.js';

import { normalizeConfigContent } from './configContent.js';
import { getConfigContentWithManagedBlocks, getManagedBlock } from './managedConfigBlock.js';

const managedBlockOptions = {
  blockNames: ['base', 'export'],
  markerPrefix: 'oxlint',
  toolName: 'oxlint',
} as const;

export async function generateOxlintConfig(config: PackageConfig, _rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxlintConfig', async () => {
    // willbooster-configs publishes config files as product code, so migration
    // must not remove package-provided linter settings.
    const shouldPreservePublishedLinterConfig = isPublishedWillboosterConfigsPackage(config);
    const filePath = path.resolve(config.dirPath, 'oxlint.config.ts');
    const existingContent = await fsUtil.readFileIgnoringError(filePath);
    const desiredContent =
      shouldPreservePublishedLinterConfig && existingContent
        ? existingContent
        : getConfigContentWithManagedBlocks({
            ...managedBlockOptions,
            desiredContent: getConfigContent(config),
            existingContent,
            filePath,
          });

    const promises: Promise<void>[] = [];
    if (!shouldPreservePublishedLinterConfig) {
      promises.push(
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.oxlintrc.json'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'biome.json'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'biome.jsonc'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.cjs'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.js'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.json'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.yaml'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.yml'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.cjs'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.js'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.mjs'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.ts'), { force: true }))
      );
    }
    if (normalizeConfigContent(existingContent) !== normalizeConfigContent(desiredContent)) {
      promises.push(promisePool.run(() => fsUtil.generateFile(filePath, desiredContent)));
    }
    await Promise.all(promises);
  });
}

function getConfigContent(config: PackageConfig): string {
  // Do not collapse this to a static import for every package. CommonJS packages
  // type-check auto-discovered oxlint.config.ts as CommonJS, so importing the ESM
  // @willbooster/oxlint-config package triggers TS1479. Keep this in sync with
  // literacy-test's generated config pattern.
  if (!config.isEsmPackage) {
    return `${getManagedBlock(
      'base',
      `// oxlint-disable unicorn/prefer-module -- Oxlint only auto-discovers .ts config files, and CommonJS avoids Node typeless ESM warnings.
const oxlintBaseConfig = require('@willbooster/oxlint-config');

const config = oxlintBaseConfig.default ?? oxlintBaseConfig;`,
      managedBlockOptions
    )}

${getManagedBlock('export', 'module.exports = config;', managedBlockOptions)}
`;
  }

  return `${getManagedBlock('base', "import config from '@willbooster/oxlint-config';", managedBlockOptions)}

${getManagedBlock('export', 'export default config;', managedBlockOptions)}
`;
}
