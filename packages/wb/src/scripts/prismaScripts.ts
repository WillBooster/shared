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
    return `PRISMA migrate deploy${additionalOptions ? ` ${additionalOptions}` : ''}`;
  }

  deployForce(project: Project): string {
    const dirName = project.packageJson.dependencies?.blitz ? 'db' : 'prisma';
    // Don't skip "migrate deploy" because restored database may be older than the current schema.
    return `rm -Rf ${dirName}/mount/prod.sqlite3*; PRISMA migrate reset --force && rm -Rf ${dirName}/mount/prod.sqlite3*
      && litestream restore -config litestream.yml -o ${dirName}/mount/prod.sqlite3 ${dirName}/mount/prod.sqlite3 && ls -ahl ${dirName}/mount/prod.sqlite3 && ALLOW_TO_SKIP_SEED=0 PRISMA migrate deploy`;
  }

  litestream(project: Project): string {
    const dirName = project.packageJson.dependencies?.blitz ? 'db' : 'prisma';
    const dbPath = `${dirName}/mount/prod.sqlite3`;
    const requiredEnvVars = {
      CLOUDFLARE_R2_ACCOUNT_ID: project.env.CLOUDFLARE_R2_ACCOUNT_ID,
      CLOUDFLARE_R2_LITESTREAM_BUCKET_NAME: project.env.CLOUDFLARE_R2_LITESTREAM_BUCKET_NAME,
      CLOUDFLARE_R2_ACCESS_KEY_ID: project.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: project.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    } as const;
    const missingEnvVars = Object.entries(requiredEnvVars)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missingEnvVars.length > 0) {
      throw new Error(`Missing environment variables for Litestream: ${missingEnvVars.join(', ')}`);
    }

    const retentionCheckInterval = project.env.WB_ENV === 'staging' ? '5m' : '1h';
    const litestreamConfig = `dbs:
  - path: ${dbPath}
    replica:
      type: s3
      endpoint: https://${requiredEnvVars.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com
      bucket: ${requiredEnvVars.CLOUDFLARE_R2_LITESTREAM_BUCKET_NAME}
      access-key-id: ${requiredEnvVars.CLOUDFLARE_R2_ACCESS_KEY_ID}
      secret-access-key: ${requiredEnvVars.CLOUDFLARE_R2_SECRET_ACCESS_KEY}
      retention: 8h
      retention-check-interval: ${retentionCheckInterval}
      sync-interval: 60s
`;

    return `${runtimeWithArgs} -e '
const fs = require("node:fs");
const { PrismaClient } = require("@prisma/client");
const CONFIG_PATH = "/etc/litestream.yml";
const CONFIG_CONTENT = ${JSON.stringify(litestreamConfig)};

async function enableWal() {
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRaw\`PRAGMA journal_mode = WAL;\`;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  await enableWal();
  fs.writeFileSync(CONFIG_PATH, CONFIG_CONTENT);
  console.info(\`Generated \${CONFIG_PATH}\`);
}

main().catch((error) => {
  console.error("Failed due to:", error);
  process.exit(1);
});
'`;
  }

  migrate(project: Project, additionalOptions = ''): string {
    return `PRISMA migrate deploy${additionalOptions ? ` ${additionalOptions}` : ''} && PRISMA generate && ${this.seed(project)}`;
  }

  migrateDev(_: Project, additionalOptions = ''): string {
    return `PRISMA migrate dev${additionalOptions ? ` ${additionalOptions}` : ''}`;
  }

  reset(project: Project, additionalOptions = ''): string {
    // cf. https://www.prisma.io/docs/guides/database/seed-database#integrated-seeding-with-prisma-migrate
    // Blitz does not trigger seed automatically, so we need to run it manually.
    return `PRISMA migrate reset --force --skip-seed${additionalOptions ? ` ${additionalOptions}` : ''} && ${this.seed(project)}`;
  }

  restore(project: Project, outputPath: string): string {
    const dirName = project.packageJson.dependencies?.blitz ? 'db' : 'prisma';
    return `rm -Rf ${outputPath}; litestream restore -config litestream.yml -o ${outputPath} ${dirName}/mount/prod.sqlite3`;
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
    return `${prefix}PRISMA studio${additionalOptions ? ` ${additionalOptions}` : ''}`;
  }
}

export const prismaScripts = new PrismaScripts();
