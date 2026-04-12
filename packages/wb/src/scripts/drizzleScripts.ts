import path from 'node:path';

import type { Project } from '../project.js';

const FILE_SCHEMA = 'file:';

class DrizzleScripts {
  deploy(project: Project, additionalOptions = ''): string {
    return this.migrate(project, additionalOptions);
  }

  migrate(_project: Project, additionalOptions = ''): string {
    return `YARN drizzle-kit migrate ${additionalOptions}`;
  }

  migrateDev(_project: Project, additionalOptions = ''): string {
    return `YARN drizzle-kit generate ${additionalOptions}`;
  }

  reset(project: Project, additionalOptions = ''): string {
    const removeCommand = buildRemoveSqliteDbCommand(project);
    if (!removeCommand) {
      return "echo 'wb db reset supports Drizzle only when DATABASE_PATH or file: DATABASE_URL is set.' && exit 1";
    }

    return `${removeCommand} && ${this.migrate(project, additionalOptions)}`;
  }

  seed(project: Project, scriptPath?: string): string {
    if (scriptPath) return `BUN build-ts run ${scriptPath}`;
    if (project.packageJson.scripts?.seed) return 'YARN run seed';
    return 'true';
  }

  studio(_project: Project, dbUrlOrPath?: string, additionalOptions = ''): string {
    if (dbUrlOrPath) {
      return "echo 'wb db studio for Drizzle does not support db-url-or-path.' && exit 1";
    }

    return `YARN drizzle-kit studio ${additionalOptions}`;
  }
}

function buildRemoveSqliteDbCommand(project: Project): string | undefined {
  const dbPath = project.env.DATABASE_PATH ?? getFileDatabaseUrlPath(project);
  if (!dbPath) return;

  const absolutePath = path.isAbsolute(dbPath) ? dbPath : path.resolve(project.dirPath, dbPath);
  return `rm -f "${absolutePath}" "${absolutePath}-wal" "${absolutePath}-shm"`;
}

function getFileDatabaseUrlPath(project: Project): string | undefined {
  const dbUrl = project.env.DATABASE_URL;
  if (!dbUrl?.startsWith(FILE_SCHEMA)) return;

  const rawDbPath = dbUrl.slice(FILE_SCHEMA.length).replace(/[?#].*$/, '');
  if (!rawDbPath) return;

  return rawDbPath;
}

export const drizzleScripts = new DrizzleScripts();
