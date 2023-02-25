import { project } from '../project.js';

class PrismaScripts {
  migrate(): string {
    return `PRISMA migrate deploy && PRISMA generate && ${this.seed()}`;
  }

  migrateDev(): string {
    return `PRISMA migrate dev`;
  }

  reset(): string {
    return `rm -f db/**/*.sqlite* && PRISMA migrate reset --force && ${this.seed()}`;
  }

  seed(): string {
    if (project.packageJson.dependencies?.['blitz']) return `YARN blitz db seed`;
    return `if [ -e "prisma/seeds.ts" ]; then YARN build-ts run prisma/seeds.ts; fi`;
  }
}

export const prismaScripts = new PrismaScripts();
