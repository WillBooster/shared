import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

const require = createRequire(import.meta.url);
const sharedConfigPath = require.resolve('@willbooster/oxfmt-config');

export async function generateOxfmtConfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxfmtConfig', async () => {
    // Oxfmt does not support extending a shared config, so wbfy writes the resolved settings directly.
    const filePath = path.resolve(config.dirPath, '.oxfmtrc.json');
    const sharedConfig = await fs.promises.readFile(sharedConfigPath, 'utf8');
    await promisePool.run(() => fsUtil.generateFile(filePath, sharedConfig));
  });
}
