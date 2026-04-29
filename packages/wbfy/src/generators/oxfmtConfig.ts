import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

export async function generateOxfmtConfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxfmtConfig', async () => {
    const legacyJsonConfigPath = path.resolve(config.dirPath, '.oxfmtrc.json');
    const unusedMtsConfigPath = path.resolve(config.dirPath, 'oxfmt.config.mts');
    const filePath = path.resolve(config.dirPath, 'oxfmt.config.ts');
    await Promise.all([
      promisePool.run(() => fs.promises.rm(legacyJsonConfigPath, { force: true })),
      promisePool.run(() => fsUtil.generateFile(filePath, getConfigContent(config))),
      // Current oxfmt auto-discovers oxfmt.config.ts but not oxfmt.config.mts.
      promisePool.run(() => fs.promises.rm(unusedMtsConfigPath, { force: true })),
    ]);
  });
}

function getConfigContent(config: PackageConfig): string {
  if (config.packageJson?.type === 'module') {
    return `import config from '@willbooster/oxfmt-config';

export default config;
`;
  }

  return `// oxlint-disable unicorn/prefer-module -- Oxfmt only auto-discovers .ts config files, and CommonJS avoids Node typeless ESM warnings.
const oxfmtConfig = require('@willbooster/oxfmt-config');

module.exports = oxfmtConfig.default ?? oxfmtConfig;
`;
}
