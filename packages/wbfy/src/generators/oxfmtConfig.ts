import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';

export async function removeOxfmtConfig(config: PackageConfig): Promise<void> {
  // The package publishes its oxfmt.config.ts for repositories still on oxfmt.
  if (config.packageJson?.name === '@willbooster/oxfmt-config') return;
  return logger.functionIgnoringException('removeOxfmtConfig', async () => {
    // `bun fmt` would otherwise layer this file under the bunfig.toml `[fmt]` section.
    await fsUtil.removeConfined(path.resolve(config.dirPath, 'oxfmt.config.ts'));
  });
}
