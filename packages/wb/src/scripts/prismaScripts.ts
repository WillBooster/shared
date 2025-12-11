import fs from 'node:fs';
import path from 'node:path';

import type { Project } from '../project.js';
import { runtimeWithArgs } from '../utils/runtime.js';

/**
 * A collection of scripts for executing Prisma commands.
 * Note that `PRISMA` is replaced with `YARN prisma` or `YARN blitz prisma`
 * and `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class PrismaScripts {
  deploy(_: Project, additionalOptions = ''): string {
    return `PRISMA migrate deploy ${additionalOptions}`;
  }

  deployForce(project: Project): string {
    const dirName = project.packageJson.dependencies?.blitz ? 'db' : 'prisma';
    // Don't skip "migrate deploy" because restored database may be older than the current schema.
    return `PRISMA migrate reset --force --skip-seed && rm -Rf ${dirName}/mount/prod.sqlite3*
      && litestream restore -config litestream.yml -o ${dirName}/mount/prod.sqlite3 ${dirName}/mount/prod.sqlite3 && ls -ahl ${dirName}/mount/prod.sqlite3 && ALLOW_TO_SKIP_SEED=0 PRISMA migrate deploy`;
  }

  listBackups(project: Project): string {
    const dirName = project.packageJson.dependencies?.blitz ? 'db' : 'prisma';
    return `litestream ltx -config litestream.yml ${dirName}/mount/prod.sqlite3`;
  }

  litestream(_: Project): string {
    return `${runtimeWithArgs} -e '
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const pragmas = [
  "PRAGMA busy_timeout = 5000;",
  "PRAGMA journal_mode = WAL;",
  "PRAGMA synchronous = NORMAL;",
  "PRAGMA wal_autocheckpoint = 0;",
];
(async () => {
  try {
    for (const pragma of pragmas) {
      await prisma.$executeRawUnsafe(pragma);
    }
  } catch (error) {
    console.error("Failed due to:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
'`;
  }

  migrate(project: Project, additionalOptions = ''): string {
    return `PRISMA migrate deploy ${additionalOptions} && PRISMA generate && ${this.seed(project)}`;
  }

  migrateDev(_: Project, additionalOptions = ''): string {
    return `PRISMA migrate dev ${additionalOptions}`;
  }

  reset(project: Project, additionalOptions = ''): string {
    // cf. https://www.prisma.io/docs/guides/database/seed-database#integrated-seeding-with-prisma-migrate
    const resetOptions = additionalOptions.trim();
    const baseReset = `PRISMA migrate reset --force ${resetOptions}`;
    const resetCommand = project.packageJson.dependencies?.blitz ? `${baseReset} && ${this.seed(project)}` : baseReset;
    const resetCommandForTest = project.packageJson.dependencies?.blitz
      ? String.raw`find db \( -name "test.db*" -o -name "test.sqlite*" \) -delete`
      : String.raw`find prisma \( -name "test.db*" -o -name "test.sqlite*" \) -delete`;
    return `${resetCommand} && ${resetCommandForTest}`;
  }

  restore(project: Project, outputPath: string): string {
    const dirName = project.packageJson.dependencies?.blitz ? 'db' : 'prisma';
    return `${this.removeSqliteArtifacts(outputPath)}; litestream restore -config litestream.yml -o ${outputPath} ${dirName}/mount/prod.sqlite3`;
  }

  seed(project: Project, scriptPath?: string): string {
    if (project.packageJson.dependencies?.blitz) return `YARN blitz db seed${scriptPath ? ` -f ${scriptPath}` : ''}`;
    if (scriptPath) return `BUN build-ts run ${scriptPath}`;
    if ((project.packageJson.prisma as Record<string, string> | undefined)?.seed) return `YARN prisma db seed`;
    return `if [ -e "prisma/seeds.ts" ]; then BUN build-ts run prisma/seeds.ts; fi`;
  }

  studio(project: Project, dbUrlOrPath?: string, additionalOptions = ''): string {
    const FILE_SCHEMA = 'file:';
    let prefix = '';
    // Deal with Prisma issue: https://github.com/prisma/studio/issues/1273
    if (dbUrlOrPath) {
      try {
        new URL(dbUrlOrPath);
        prefix = `DATABASE_URL=${dbUrlOrPath} `;
      } catch {
        const absolutePath = path.resolve(dbUrlOrPath);
        prefix = `DATABASE_URL=${FILE_SCHEMA}${absolutePath} `;
      }
    } else if (project.env.DATABASE_URL?.startsWith(FILE_SCHEMA)) {
      const POSSIBLE_PATHS = [
        { schemaPath: path.join('prisma', 'schema.prisma'), dbPath: 'prisma' },
        { schemaPath: path.join('prisma', 'schema'), dbPath: path.join('prisma', 'schema') },
        { schemaPath: path.join('db', 'schema.prisma'), dbPath: 'db' },
      ];
      for (const { dbPath, schemaPath } of POSSIBLE_PATHS) {
        if (fs.existsSync(path.resolve(project.dirPath, schemaPath))) {
          const absolutePath = path.resolve(
            project.dirPath,
            dbPath,
            project.env.DATABASE_URL.slice(FILE_SCHEMA.length)
          );
          prefix = `DATABASE_URL=${FILE_SCHEMA}${absolutePath} `;
          break;
        }
      }
    }
    return `${prefix}PRISMA studio ${additionalOptions}`;
  }

  private removeSqliteArtifacts(sqlitePath: string): string {
    // Litestream requires removing WAL/SHM and Litestream sidecar files when recreating databases.
    return `rm -Rf ${sqlitePath} ${sqlitePath}-shm ${sqlitePath}-wal ${sqlitePath}-litestream`;
  }
}

export const prismaScripts = new PrismaScripts();
