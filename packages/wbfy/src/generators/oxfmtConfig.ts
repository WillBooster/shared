import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

export async function generateOxfmtConfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxfmtConfig', async () => {
    const legacyConfigPath = path.resolve(config.dirPath, '.oxfmtrc.json');
    const filePath = path.resolve(config.dirPath, 'oxfmt.config.ts');
    await promisePool.run(() => fs.promises.rm(legacyConfigPath, { force: true }));
    if (fs.existsSync(filePath)) return;
    await promisePool.run(() => fsUtil.generateFile(filePath, configContent));
  });
}

const configContent = `import config from '@willbooster/oxfmt-config';

export default config;
`;
