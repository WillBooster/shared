import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

import { generateToolConfigContent, normalizeToolConfigContent } from './toolConfigContent.js';

export async function generateOxfmtConfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxfmtConfig', async () => {
    const legacyJsonConfigPath = path.resolve(config.dirPath, '.oxfmtrc.json');
    const filePath = path.resolve(config.dirPath, 'oxfmt.config.ts');
    const existingContent = await fsUtil.readFileIgnoringError(filePath);
    const desiredContent = getConfigContent();
    const promises = [promisePool.run(() => fs.promises.rm(legacyJsonConfigPath, { force: true }))];
    if (normalizeToolConfigContent(existingContent) !== normalizeToolConfigContent(desiredContent)) {
      promises.push(promisePool.run(() => fsUtil.generateFile(filePath, desiredContent)));
    }
    await Promise.all(promises);
  });
}

function getConfigContent(): string {
  return generateToolConfigContent({
    packageName: '@willbooster/oxfmt-config',
  });
}
