import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

import { generateToolConfigContent } from './toolConfigContent.js';

export async function generateOxfmtConfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxfmtConfig', async () => {
    const legacyJsonConfigPath = path.resolve(config.dirPath, '.oxfmtrc.json');
    const filePath = path.resolve(config.dirPath, 'oxfmt.config.ts');
    await Promise.all([
      promisePool.run(() => fs.promises.rm(legacyJsonConfigPath, { force: true })),
      promisePool.run(() => fsUtil.generateFile(filePath, getConfigContent(config))),
    ]);
  });
}

function getConfigContent(config: PackageConfig): string {
  return generateToolConfigContent(config, {
    commonJsVariableName: 'oxfmtConfig',
    packageName: '@willbooster/oxfmt-config',
    toolName: 'Oxfmt',
  });
}
