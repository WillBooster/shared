import fs from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { globIgnore } from '../utils/globUtil.js';

export async function fixPrismaEnvFiles(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixPrismaEnvFiles', async () => {
    const shouldAddConnectionLimit = shouldAddSqliteConnectionLimit(config);
    const envFiles = await fg.glob(['*.env', '*.env.*'], { dot: true, cwd: config.dirPath, ignore: globIgnore });
    for (const envFile of envFiles) {
      const envFilePath = path.resolve(config.dirPath, envFile);
      const content = await fs.readFile(envFilePath, 'utf8');
      const newContent = content.replaceAll(
        /DATABASE_URL\s*=\s*"?([^"#\n]+?\.sqlite3[^"#\n]*)"?/g,
        (match, url: string) => {
          return `DATABASE_URL="${normalizeSqliteDatabaseUrl(url, shouldAddConnectionLimit)}"`;
        }
      );
      await fs.writeFile(envFilePath, newContent);
    }
  });
}

function shouldAddSqliteConnectionLimit(config: PackageConfig): boolean {
  // `connection_limit=1` is a Prisma-specific SQLite datasource tweak.
  // Non-Prisma projects should keep their DATABASE_URL untouched.
  return config.depending.prisma;
}

function normalizeSqliteDatabaseUrl(url: string, shouldAddConnectionLimit: boolean): string {
  const [pathPart, queryPart] = url.split('?', 2);
  const params = new URLSearchParams(queryPart);

  params.delete('connection_limit');
  if (shouldAddConnectionLimit) {
    params.set('connection_limit', '1');
  }

  const normalizedQuery = params.toString();
  return normalizedQuery ? `${pathPart}?${normalizedQuery}` : pathPart;
}
