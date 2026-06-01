import fs from 'node:fs';
import path from 'node:path';

import type { Project } from '../project.js';
import { FILE_SCHEMA, getFileDatabaseUrlPath } from '../project.js';

const LITESTREAM_CONFIG_FILE_NAME = 'litestream.yml';
const DEFAULT_LITESTREAM_CONFIG_PATH = '/etc/litestream.yml';

const POSSIBLE_PRISMA_PATHS = [
  { schemaPath: path.join('prisma', 'schema.prisma'), dbPath: 'prisma' },
  { schemaPath: path.join('prisma', 'schema'), dbPath: path.join('prisma', 'schema') },
  { schemaPath: path.join('db', 'schema.prisma'), dbPath: 'db' },
];

/**
 * A collection of scripts for executing Prisma commands.
 * Note that `PRISMA` is replaced with `YARN prisma` or `YARN blitz prisma`
 * and `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class PrismaScripts {
  cleanUpLitestream(project: Project): string {
    const dirPath = getDatabaseDirPath(project);
    const cleanUpCommand = buildWalCheckpointAndRemoveSqliteSidecarFilesCommand(`${dirPath}/prod.sqlite3`);
    // Cleanup existing artifacts to avoid issues with Litestream replication.
    // Note that don't merge multiple rm commands into one, because if one fails, the subsequent ones won't run.
    return `${cleanUpCommand}; rm -Rf ${dirPath}/.prod.sqlite3* || true`;
  }

  deploy(_: Project, additionalOptions = ''): string {
    return `PRISMA migrate deploy ${additionalOptions}`;
  }

  generate(_: Project, additionalOptions = ''): string {
    return ['PRISMA generate', additionalOptions].filter(Boolean).join(' ');
  }

  deployForce(project: Project): string {
    const dirPath = getDatabaseDirPath(project);
    const removeDbCommand = buildRemoveSqliteDbCommand(`${dirPath}/prod.sqlite3`);
    const litestreamConfigOption = getLitestreamConfigOption(project);
    // `prisma migrate reset` can fail depending on the state of the existing database, so we remove it first.
    // Don't skip "migrate deploy" because restored database may be older than the current schema.
    return `${removeDbCommand}; PRISMA migrate reset --force --skip-seed && ${removeDbCommand}
      && litestream restore ${litestreamConfigOption} -o ${dirPath}/prod.sqlite3 ${dirPath}/prod.sqlite3 && ls -ahl ${dirPath}/prod.sqlite3 && ALLOW_TO_SKIP_SEED=0 PRISMA migrate deploy`;
  }

  listBackups(project: Project): string {
    const dirPath = getDatabaseDirPath(project);
    return `litestream ltx ${getLitestreamConfigOption(project)} ${dirPath}/prod.sqlite3`;
  }

  migrate(project: Project, additionalOptions = ''): string {
    return `PRISMA migrate deploy ${additionalOptions} && ${this.generate(project)} && ${this.seed(project)}`;
  }

  migrateDev(_: Project, additionalOptions = ''): string {
    return `PRISMA migrate dev ${additionalOptions}`;
  }

  reset(project: Project, additionalOptions = ''): string {
    // cf. https://www.prisma.io/docs/guides/database/seed-database#integrated-seeding-with-prisma-migrate
    const steps: string[] = [];
    const cleanupCommand = cleanUpSqliteDbIfNeeded(project);
    if (cleanupCommand) steps.push(cleanupCommand);
    const resetCommand = ['PRISMA migrate reset --force', additionalOptions].filter(Boolean).join(' ');
    steps.push(resetCommand);
    if (project.packageJson.dependencies?.blitz) {
      // Blitz does not trigger seed automatically, so we need to run it manually.
      steps.push(this.seed(project));
    }
    return steps.filter(Boolean).join(' && ');
  }

  restore(project: Project, outputPath: string): string {
    const dirPath = getDatabaseDirPath(project);
    return `rm -Rf ${outputPath}*; litestream restore ${getLitestreamConfigOption(project)} -o ${outputPath} ${dirPath}/prod.sqlite3`;
  }

  seed(project: Project, scriptPath?: string): string {
    if (project.packageJson.dependencies?.blitz) return `YARN blitz db seed${scriptPath ? ` -f ${scriptPath}` : ''}`;
    if (scriptPath) return `BUN build-ts run ${scriptPath}`;
    if ((project.packageJson.prisma as Record<string, string> | undefined)?.seed) return `YARN prisma db seed`;
    return `if [ -e "prisma/seeds.ts" ]; then BUN build-ts run prisma/seeds.ts; fi`;
  }

  studio(project: Project, dbUrlOrPath?: string, additionalOptions = ''): string {
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
      const baseDir = getPrismaBaseDir(project);
      if (baseDir) {
        const absolutePath = path.resolve(project.dirPath, baseDir, project.env.DATABASE_URL.slice(FILE_SCHEMA.length));
        prefix = `DATABASE_URL=${FILE_SCHEMA}${absolutePath} `;
      }
    }
    return `${prefix}PRISMA studio ${additionalOptions}`;
  }
}

function getDatabaseDirPath(project: Project): string {
  return project.packageJson.dependencies?.blitz ? 'db/mount' : 'prisma/mount';
}

function getPrismaBaseDir(project: Project): string | undefined {
  return POSSIBLE_PRISMA_PATHS.find(({ schemaPath }) => fs.existsSync(path.resolve(project.dirPath, schemaPath)))
    ?.dbPath;
}

function getLitestreamConfigOption(project: Project): string {
  const localConfigPath = path.join(project.dirPath, LITESTREAM_CONFIG_FILE_NAME);
  if (fs.existsSync(localConfigPath)) return `-config ./${LITESTREAM_CONFIG_FILE_NAME}`;
  if (fs.existsSync(DEFAULT_LITESTREAM_CONFIG_PATH)) return `-config ${DEFAULT_LITESTREAM_CONFIG_PATH}`;
  return `-config ./${LITESTREAM_CONFIG_FILE_NAME}`;
}

function buildRemoveSqliteDbCommand(dbPath: string): string {
  return `rm -Rf "${dbPath}"*`;
}

function buildWalCheckpointAndRemoveSqliteSidecarFilesCommand(dbPath: string): string {
  return `if [ -f "${dbPath}" ]; then printf 'PRAGMA wal_checkpoint(TRUNCATE);' | PRISMA db execute --stdin --url "${FILE_SCHEMA}${dbPath}"; fi && rm -f "${dbPath}".* "${dbPath}"-*`;
}

export function cleanUpSqliteDbIfNeeded(project: Project): string | undefined {
  const rawDbPath = getFileDatabaseUrlPath(project);
  if (!rawDbPath) return;

  const baseDir = getPrismaBaseDir(project);
  const absolutePath = path.isAbsolute(rawDbPath)
    ? rawDbPath
    : path.resolve(project.dirPath, baseDir ?? '.', rawDbPath);

  return `rm -f "${absolutePath}" "${absolutePath}-wal" "${absolutePath}-shm"`;
}

export const prismaScripts = new PrismaScripts();
