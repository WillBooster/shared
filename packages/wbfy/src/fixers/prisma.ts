import fs from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { globIgnore } from '../utils/globUtil.js';

export async function fixPrismaEnvFiles(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixPrismaEnvFiles', async () => {
    const envFiles = await fg.glob(['*.env', '*.env.*'], { dot: true, cwd: config.dirPath, ignore: globIgnore });
    for (const envFile of envFiles) {
      const envFilePath = path.resolve(config.dirPath, envFile);
      const content = await fs.readFile(envFilePath, 'utf8');
      const newContent = content.replace(
        /DATABASE_URL="?(.+\.sqlite3)"?[\n$]/,
        'DATABASE_URL="$1?connection_limit=1"\n'
      );
      await fs.writeFile(envFilePath, newContent);
    }
  });
}
