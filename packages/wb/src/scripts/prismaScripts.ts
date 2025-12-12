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
  cleanUpLitestream(project: Project): string {
    const dirPath = getDatabaseDirPath(project);
    // Cleanup existing artifacts to avoid issues with Litestream replication.
    // Note that don't merge multiple rm commands into one, because if one fails, the subsequent ones won't run.
    return `rm -Rf ${dirPath}/prod.sqlite3-*; rm -Rf ${dirPath}/prod.sqlite3.*; rm -Rf ${dirPath}/.prod.sqlite3* || true`;
  }

  deploy(_: Project, additionalOptions = ''): string {
    return `PRISMA migrate deploy ${additionalOptions}`;
  }

  deployForce(project: Project): string {
    const dirPath = getDatabaseDirPath(project);
    // `prisma migrate reset` sometimes fails if the existing database schema, so we remove it first.
    // Don't skip "migrate deploy" because restored database may be older than the current schema.
    return `rm -Rf ${dirPath}/prod.sqlite3*; PRISMA migrate reset --force --skip-seed && rm -Rf ${dirPath}/prod.sqlite3*
      && litestream restore -config litestream.yml -o ${dirPath}/prod.sqlite3 ${dirPath}/prod.sqlite3 && ls -ahl ${dirPath}/prod.sqlite3 && ALLOW_TO_SKIP_SEED=0 PRISMA migrate deploy`;
  }

  listBackups(project: Project): string {
    const dirPath = getDatabaseDirPath(project);
    return `litestream ltx -config litestream.yml ${dirPath}/prod.sqlite3`;
  }

  migrate(project: Project, additionalOptions = ''): string {
    return `PRISMA migrate deploy ${additionalOptions} && PRISMA generate && ${this.seed(project)}`;
  }

  migrateDev(_: Project, additionalOptions = ''): string {
    return `PRISMA migrate dev ${additionalOptions}`;
  }

  reset(project: Project, additionalOptions = ''): string {
    // cf. https://www.prisma.io/docs/guides/database/seed-database#integrated-seeding-with-prisma-migrate
    if (project.packageJson.dependencies?.blitz) {
      // Blitz does not trigger seed automatically, so we need to run it manually.
      return `PRISMA migrate reset --force ${additionalOptions} && ${this.seed(project)}`;
    }
    return `PRISMA migrate reset --force ${additionalOptions}`;
  }

  restore(project: Project, outputPath: string): string {
    const dirPath = getDatabaseDirPath(project);
    return `rm -Rf ${outputPath}*; litestream restore -config litestream.yml -o ${outputPath} ${dirPath}/prod.sqlite3`;
  }

  seed(project: Project, scriptPath?: string): string {
    if (project.packageJson.dependencies?.blitz) return `YARN blitz db seed${scriptPath ? ` -f ${scriptPath}` : ''}`;
    if (scriptPath) return `BUN build-ts run ${scriptPath}`;
    if ((project.packageJson.prisma as Record<string, string> | undefined)?.seed) return `YARN prisma db seed`;
    return `if [ -e "prisma/seeds.ts" ]; then BUN build-ts run prisma/seeds.ts; fi`;
  }

  setUpDBForLitestream(_: Project): string {
    // cf. https://litestream.io/tips/
    return `${runtimeWithArgs} -e '
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
(async () => {
  try {
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
    await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
    await prisma.$queryRawUnsafe("PRAGMA synchronous = NORMAL");
    await prisma.$queryRawUnsafe("PRAGMA wal_autocheckpoint = 0");
  } catch (error) {
    console.error("Failed due to:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
'`;
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
}

function getDatabaseDirPath(project: Project): string {
  return project.packageJson.dependencies?.blitz ? 'db/mount' : 'prisma/mount';
}

export const prismaScripts = new PrismaScripts();
