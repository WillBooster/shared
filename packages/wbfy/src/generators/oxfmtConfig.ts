import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { isPublishedWillboosterConfigsPackage } from '../utils/willboosterConfigsUtil.js';

export async function removeOxfmtConfig(config: PackageConfig): Promise<void> {
  // `@willbooster/oxfmt-config` publishes its oxfmt.config.ts for repositories still on oxfmt.
  if (isPublishedWillboosterConfigsPackage(config)) return;
  return logger.functionIgnoringException('removeOxfmtConfig', async () => {
    // `bun fmt` would otherwise layer this file under the bunfig.toml `[fmt]` section.
    await fsUtil.removeConfined(path.resolve(config.dirPath, 'oxfmt.config.ts'));
  });
}
