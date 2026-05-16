import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

const managedScriptsBlock = `scripts/**
!scripts/
!scripts/*.sh`;

export async function fixRailwayignore(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixRailwayignore', async () => {
    const filePath = path.resolve(config.dirPath, '.railwayignore');
    const content = await fsUtil.readFileIgnoringError(filePath);
    if (!content) return;

    const newContent = content.replace(/^scripts\/$/m, managedScriptsBlock);
    if (newContent === content) return;

    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}
