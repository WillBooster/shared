import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

import { normalizeConfigContent } from './configContent.js';
import { getConfigContentWithManagedBlocks, getManagedBlock } from './managedConfigBlock.js';

const managedBlockOptions = {
  blockNames: ['base', 'export'],
  markerPrefix: 'oxfmt',
  toolName: 'oxfmt',
} as const;

export async function generateOxfmtConfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxfmtConfig', async () => {
    const legacyJsonConfigPath = path.resolve(config.dirPath, '.oxfmtrc.json');
    const filePath = path.resolve(config.dirPath, 'oxfmt.config.ts');
    const existingContent = await fsUtil.readFileIgnoringError(filePath);
    const desiredContent = getConfigContentWithManagedBlocks({
      ...managedBlockOptions,
      desiredContent: getConfigContent(config),
      existingContent,
      filePath,
    });
    const promises = [promisePool.run(() => fs.promises.rm(legacyJsonConfigPath, { force: true }))];
    if (normalizeConfigContent(existingContent) !== normalizeConfigContent(desiredContent)) {
      promises.push(promisePool.run(() => fsUtil.generateFile(filePath, desiredContent)));
    }
    await Promise.all(promises);
  });
}

function getConfigContent(config: PackageConfig): string {
  // CommonJS packages need require/module.exports here: oxfmt config files are
  // only auto-discovered as .ts, and the shared config package is ESM-only.
  if (!config.isEsmPackage) {
    return `${getManagedBlock(
      'base',
      `// oxlint-disable unicorn/prefer-module -- Oxfmt config files are only auto-discovered as .ts, and CommonJS avoids Node typeless ESM warnings.
const oxfmtConfig = require('@willbooster/oxfmt-config');

const config = oxfmtConfig.default ?? oxfmtConfig;`,
      managedBlockOptions
    )}

${getManagedBlock('export', 'module.exports = config;', managedBlockOptions)}
`;
  }

  return `${getManagedBlock('base', "import config from '@willbooster/oxfmt-config';", managedBlockOptions)}

${getManagedBlock('export', 'export default config;', managedBlockOptions)}
`;
}
