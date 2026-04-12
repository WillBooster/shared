import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';

export async function removeGeminiSettings(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateGeminiSettings', async () => {
    if (!config.isRoot) return;

    const dirPath = path.resolve(config.dirPath, '.gemini');
    const filePath = path.resolve(dirPath, 'settings.json');
    await fs.promises.rm(filePath, { force: true });
  });
}
