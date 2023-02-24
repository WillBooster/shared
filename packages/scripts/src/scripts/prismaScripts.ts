import { project } from '../project.js';

class PrismaScripts {
  migrate(): string {
    return `YARN prisma migrate deploy && YARN prisma generate && ${this.seed()}`;
  }

  migrateDev(): string {
    return `YARN prisma migrate dev`;
  }

  reset(): string {
    return `rm -f db/**/*.sqlite* && YARN prisma migrate reset --force && ${this.seed()}`;
  }

  seed(): string {
    if (project.packageJson.dependencies?.['blitz']) return `YARN blitz db seed`;
    return `true $([ -e "prisma/seeds.ts" ] && YARN build-ts run prisma/seeds.ts)`;
  }
}

export const prismaScripts = new PrismaScripts();
