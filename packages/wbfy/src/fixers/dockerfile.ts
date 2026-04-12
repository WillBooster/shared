import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';

export async function fixDockerfile(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixDockerfile', async () => {
    if (!config.doesContainDockerfile) return;

    const oldContent = config.dockerfile;
    const newContent = oldContent;

    if (oldContent === newContent) return;
    await fs.writeFile(path.join(config.dirPath, 'Dockerfile'), newContent);
  });
}
