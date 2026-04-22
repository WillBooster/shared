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
  if (!config.depending.prisma) return false;

  const dependencies = {
    ...config.packageJson?.dependencies,
    ...config.packageJson?.devDependencies,
  };

  // `connection_limit=1` only applies to Prisma's SQLite datasource handling.
  // Repos that opt into non-pure SQLite adapters should keep their URL as-is.
  return !dependencies['@prisma/adapter-better-sqlite3'] && !dependencies['@prisma/adapter-libsql'];
}

function normalizeSqliteDatabaseUrl(url: string, shouldAddConnectionLimit: boolean): string {
  const queryStart = url.indexOf('?');
  const pathPart = queryStart !== -1 ? url.slice(0, queryStart) : url;
  const queryPart = queryStart !== -1 ? url.slice(queryStart + 1) : '';
  const params = new URLSearchParams(queryPart);

  params.delete('connection_limit');
  if (shouldAddConnectionLimit) {
    params.set('connection_limit', '1');
  }

  const normalizedQuery = params.toString();
  return normalizedQuery ? `${pathPart}?${normalizedQuery}` : pathPart;
}
