import path from 'node:path';

import { project } from '../project.js';

/**
 * A collection of scripts for executing Prisma commands.
 * Note that `PRISMA` is replaced with `YARN prisma` or `YARN blitz prisma`
 * and `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class PrismaScripts {
  deploy(): string {
    return 'PRISMA migrate deploy';
  }

  deployForce(backupPath: string): string {
    const dirName = project.packageJson.dependencies?.['blitz'] ? 'db' : 'prisma';
    // Don't skip "migrate deploy" because restored database may be older than the current schema.
    return `rm -Rf ${dirName}/mount/prod.sqlite3*; PRISMA migrate reset --force && rm -Rf ${dirName}/mount/prod.sqlite3*
      && litestream restore -o ${dirName}/mount/prod.sqlite3 ${backupPath} && ALLOW_TO_SKIP_SEED=0 PRISMA migrate deploy`;
  }

  litestream(): string {
    return `node -e '
const { PrismaClient } = require("@prisma/client");
new PrismaClient().$queryRaw\`PRAGMA journal_mode = WAL;\`
  .catch((error) => { console.log("Failed due to:", error); process.exit(1); });
'`;
  }

  migrate(): string {
    return `PRISMA migrate deploy && PRISMA generate && ${this.seed()}`;
  }

  migrateDev(): string {
    return `PRISMA migrate dev`;
  }

  reset(): string {
    // cf. https://www.prisma.io/docs/guides/database/seed-database#integrated-seeding-with-prisma-migrate
    // Blitz does not trigger seed automatically, so we need to run it manually.
    return `PRISMA migrate reset --force --skip-seed && ${this.seed()}`;
    // I'm not sure why we need to remove all sqlite files, so I commented out the following line.
    // return `true $(rm -Rf db/**/*.sqlite* 2> /dev/null) && true $(rm -Rf prisma/**/*.sqlite* 2> /dev/null) && PRISMA migrate reset --force --skip-seed && ${this.seed()}`;
  }

  restore(backupPath: string, outputPath: string): string {
    const dirName = project.packageJson.dependencies?.['blitz'] ? 'db' : 'prisma';
    return `rm -Rf ${dirName}/restored.sqlite3; GOOGLE_APPLICATION_CREDENTIALS=gcp-sa-key.json litestream restore -o ${outputPath} ${backupPath}`;
  }

  seed(): string {
    if (project.packageJson.dependencies?.['blitz']) return `YARN blitz db seed`;
    if ((project.packageJson.prisma as Record<string, string> | undefined)?.['seed']) return `YARN prisma db seed`;
    return `if [ -e "prisma/seeds.ts" ]; then YARN build-ts run prisma/seeds.ts; fi`;
  }

  studio(dbUrlOrPath?: string): string {
    let prefix = '';
    if (dbUrlOrPath) {
      try {
        new URL(dbUrlOrPath);
        prefix = `DATABASE_URL=${dbUrlOrPath} `;
      } catch {
        const absolutePath = path.resolve(dbUrlOrPath);
        console.info(dbUrlOrPath, absolutePath);
        prefix = `DATABASE_URL=file://${absolutePath} `;
      }
    }
    return `${prefix}PRISMA studio`;
  }
}

export const prismaScripts = new PrismaScripts();
