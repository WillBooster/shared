import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { isPublishedWillboosterConfigsPackage } from '../utils/willboosterConfigsUtil.js';

import { normalizeConfigContent } from './configContent.js';
import { ManagedConfigBlocks } from './managedConfigBlock.js';

const managedConfigBlocks = new ManagedConfigBlocks({
  blockNames: ['base', 'export'],
  markerPrefix: 'oxlint',
  toolName: 'oxlint',
});

export async function generateOxlintConfig(config: PackageConfig, _rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxlintConfig', async () => {
    // willbooster-configs publishes config files as product code, so migration
    // must not remove package-provided linter settings. Generated files with
    // managed blocks are still safe to update.
    const shouldPreservePublishedLinterConfig = isPublishedWillboosterConfigsPackage(config);
    const filePath = path.resolve(config.dirPath, 'oxlint.config.ts');
    const existingContent = await fsUtil.readFileIgnoringError(filePath);
    const shouldPreserveExistingContent =
      shouldPreservePublishedLinterConfig && existingContent && !managedConfigBlocks.hasManagedBlocks(existingContent);
    const desiredContent = shouldPreserveExistingContent
      ? existingContent
      : replaceLegacyConfigReferences(
          managedConfigBlocks.getConfigContent({
            desiredContent: getConfigContent(config),
            existingContent,
            filePath,
          })
        );

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

function replaceLegacyConfigReferences(content: string): string {
  return content.replaceAll(/(?<![./])\bconfig\./gu, 'oxlintResolvedConfig.');
}

function getConfigContent(config: PackageConfig): string {
  const isRootConfig = config.isRoot;
  const oxlintBaseConfigModule = getOxlintBaseConfigModule(config);

  // Do not collapse this to a static import for every package. CommonJS packages
  // type-check auto-discovered oxlint.config.ts as CommonJS, so importing the ESM
  // @willbooster/oxlint-config package triggers TS1479. Keep this in sync with
  // literacy-test's generated config pattern.
  if (!config.isEsmPackage) {
    return `${managedConfigBlocks.getBlock(
      'base',
      `/// <reference types="node" />
// oxlint-disable unicorn/prefer-module -- Oxlint only auto-discovers .ts config files, and CommonJS avoids ESM package loading issues.
const oxlintBaseConfig = require('@willbooster/oxlint-config');

${getResolvedConfigContent('oxlintBaseConfig.default ?? oxlintBaseConfig', isRootConfig)}`
    )}

${managedConfigBlocks.getBlock('export', 'module.exports = oxlintResolvedConfig;')}
`;
  }

  return `${managedConfigBlocks.getBlock(
    'base',
    `import oxlintBaseConfig from '${oxlintBaseConfigModule}';

${getResolvedConfigContent('oxlintBaseConfig', isRootConfig)}`
  )}

${managedConfigBlocks.getBlock('export', 'export default oxlintResolvedConfig;')}
`;
}

function getOxlintBaseConfigModule(config: PackageConfig): string {
  return config.packageJson?.name === '@willbooster/oxlint-config' ? './config.mjs' : '@willbooster/oxlint-config';
}

function getResolvedConfigContent(baseConfigName: string, isRootConfig: boolean): string {
  if (isRootConfig) {
    return `const oxlintResolvedConfig = ${baseConfigName};`;
  }

  return `// Oxlint only supports type-aware options in the root config, while it
// still auto-discovers package-local config files in monorepos. Keep this as a
// plain object copy so package typechecks do not export oxlint's private helper
// types through the generated config variable.
const oxlintResolvedConfig: Record<string, unknown> = { ...${baseConfigName} };
delete oxlintResolvedConfig.options;`;
}
