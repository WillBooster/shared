import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';

export async function removeEnvExample(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('removeEnvExample', async () => {
    const filePath = path.resolve(config.dirPath, '.env.example');
    if (!(await fs.promises.lstat(filePath).catch(() => {}))) return;
    if (await fsUtil.removeConfined(filePath)) console.log(`Removed ${filePath}`);
  });
}
