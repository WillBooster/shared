import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

import { normalizeConfigContent } from './configContent.js';
import { ManagedConfigBlocks } from './managedConfigBlock.js';

const managedConfigBlocks = new ManagedConfigBlocks({
  blockNames: ['base', 'export'],
  markerPrefix: 'oxfmt',
  toolName: 'oxfmt',
});

export async function generateOxfmtConfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxfmtConfig', async () => {
    const legacyJsonConfigPath = path.resolve(config.dirPath, '.oxfmtrc.json');
    const filePath = path.resolve(config.dirPath, 'oxfmt.config.ts');
    const existingContent = await fsUtil.readFileIgnoringError(filePath);
    const desiredContent = managedConfigBlocks.getConfigContent({
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
    return `${managedConfigBlocks.getBlock(
      'base',
      `/// <reference types="node" />
import type { OxfmtConfig } from 'oxfmt';

// oxlint-disable unicorn/prefer-module -- Oxfmt config files are only auto-discovered as .ts, and CommonJS avoids ESM package loading issues.
const oxfmtConfig = require('@willbooster/oxfmt-config');

const oxfmtResolvedConfig: OxfmtConfig = oxfmtConfig.default ?? oxfmtConfig;`
    )}

${managedConfigBlocks.getBlock('export', 'module.exports = oxfmtResolvedConfig;')}
`;
  }

  return `${managedConfigBlocks.getBlock(
    'base',
    `import type { OxfmtConfig } from 'oxfmt';

import config from '@willbooster/oxfmt-config';

const oxfmtResolvedConfig: OxfmtConfig = config;`
  )}

${managedConfigBlocks.getBlock('export', 'export default oxfmtResolvedConfig;')}
`;
}
