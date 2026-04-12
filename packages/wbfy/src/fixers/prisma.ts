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
      const newContent = content.replaceAll(
        /DATABASE_URL\s*=\s*"?([^"#\n]+?\.sqlite3[^"#\n]*)"?/g,
        (match, url: string) => {
          if (url.includes('connection_limit=1')) return match;
          const separator = url.includes('?') ? '&' : '?';
          return `DATABASE_URL="${url}${separator}connection_limit=1"`;
        }
      );
      await fs.writeFile(envFilePath, newContent);
    }
  });
}
