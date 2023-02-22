import { PackageJson } from 'type-fest';

class PrismaScripts {
  migrate(packageJson: PackageJson): string {
    return `YARN prisma migrate deploy && YARN prisma generate && ${this.seed(packageJson)}`;
  }

  migrateDev(): string {
    return `YARN prisma migrate dev`;
  }

  reset(packageJson: PackageJson): string {
    return `rm -f db/**/*.sqlite* && YARN prisma migrate reset --force && ${this.seed(packageJson)}`;
  }

  seed(packageJson: PackageJson): string {
    if (packageJson.dependencies?.['blitz']) return `YARN blitz db seed`;
    return `true $([ -e "prisma/seeds.ts" ] && YARN build-ts run prisma/seeds.ts)`;
  }
}

export const prismaScripts = new PrismaScripts();
