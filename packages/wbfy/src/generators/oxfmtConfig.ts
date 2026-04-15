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
    await promisePool.run(() => fsUtil.generateFile(filePath, configContent));
  });
}

const configContent = `const configModule = await import('@willbooster/oxfmt-config').catch((error: unknown) => {
  // @willbooster/oxfmt-config@1.1.0 exposed JSON as the package entrypoint.
  if (error instanceof Error && 'code' in error && error.code === 'ERR_IMPORT_ATTRIBUTE_MISSING') {
    return import('@willbooster/oxfmt-config', { with: { type: 'json' } });
  }
  throw error;
});

export default configModule.default;
`;
