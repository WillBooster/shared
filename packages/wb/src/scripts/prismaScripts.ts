import { project } from '../project.js';

/**
 * A collection of scripts for executing Prisma commands.
 * Note that `PRISMA` is replaced with `YARN prisma` or `YARN blitz prisma`
 * and `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class PrismaScripts {
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

  reset(prefix = ''): string {
    // cf. https://www.prisma.io/docs/guides/database/seed-database#integrated-seeding-with-prisma-migrate
    return `rm -f db/**/*.sqlite* && ${prefix}PRISMA migrate reset --force --skip-seed && ${prefix}${this.seed()}`;
  }

  seed(): string {
    if (project.packageJson.dependencies?.['blitz']) return `YARN blitz db seed`;
    return `if [ -e "prisma/seeds.ts" ]; then YARN build-ts run prisma/seeds.ts; fi`;
  }

  studio(): string {
    return `PRISMA studio`;
  }
}

export const prismaScripts = new PrismaScripts();
