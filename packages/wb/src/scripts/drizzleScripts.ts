import fs from 'node:fs';
import path from 'node:path';

import { getAbsoluteFileDatabaseUrlPath, isProjectEnvironment, type Project } from '../project.js';
import { buildMaterializeLocalD1Command, getD1DatabaseName, getLocalWranglerStateDir } from '../utils/wrangler.js';

const LITESTREAM_CONFIG_FILE_NAME = 'litestream.yml';
const DEFAULT_LITESTREAM_CONFIG_PATH = '/etc/litestream.yml';

class DrizzleScripts {
  cleanUpLitestream(project: Project): string {
    const dbPath = getAbsoluteSqliteDbPath(project, 'cleanup-litestream');
    const walCheckpointCommand = `if [ -f "${dbPath}" ] && command -v sqlite3 >/dev/null; then printf 'PRAGMA wal_checkpoint(TRUNCATE);' | sqlite3 "${dbPath}"; fi`;
    return `${walCheckpointCommand}; rm -f "${dbPath}".* "${dbPath}"-*; rm -Rf "${path.dirname(dbPath)}/.${path.basename(dbPath)}"* || true`;
  }

  reset(project: Project, additionalOptions = ''): string {
    const d1DatabaseName = getD1DatabaseName(project);
    if (d1DatabaseName) {
      // Remove the whole local wrangler state, then re-materialize the D1 SQLite file. Its path is
      // deterministic, so a DATABASE_URL exported before the removal stays valid.
      // Remove only the D1 subtree so that other locally-persisted bindings (KV, R2, Durable Objects) survive.
      return `rm -Rf "${getLocalWranglerStateDir(project)}/v3/d1" && ${buildMaterializeLocalD1Command(project, d1DatabaseName)} && ${this.migrate(project, additionalOptions)}`;
    }

    const removeCommand = buildRemoveSqliteDbCommand(project);
    if (!removeCommand) {
      return "echo 'wb db reset supports Drizzle only when file: DATABASE_URL is set.' && exit 1";
    }

    return `${removeCommand} && ${this.migrate(project, additionalOptions)}`;
  }

  migrate(project: Project, additionalOptions = ''): string {
    const seedCommand = this.seed(project);
    const migrateCommand = this.deploy(project, additionalOptions);
    return seedCommand === 'true' ? migrateCommand : `${migrateCommand} && ${seedCommand}`;
  }

  migrateForStart(project: Project, additionalOptions = ''): string {
    if (isProjectEnvironment(project, 'test') && (buildRemoveSqliteDbCommand(project) || getD1DatabaseName(project))) {
      return this.reset(project, additionalOptions);
    }
    return this.migrate(project, additionalOptions);
  }

  deploy(_project: Project, additionalOptions = ''): string {
    return `YARN drizzle-kit migrate ${additionalOptions}`;
  }

  deployForce(project: Project): string {
    const dbPath = getAbsoluteSqliteDbPath(project, 'deploy-force');
    const removeDbCommand = buildRemoveSqliteDbFamilyCommand(dbPath);
    const litestreamConfigOption = getLitestreamConfigOption(project);
    return `${removeDbCommand}; ${this.deploy(project)} && ${removeDbCommand}
      && litestream restore ${litestreamConfigOption} -o "${dbPath}" "${dbPath}" && ls -ahl "${dbPath}" && ALLOW_TO_SKIP_SEED=0 ${this.deploy(project)}`;
  }

  listBackups(project: Project, configPath?: string): string {
    const dbPath = getAbsoluteSqliteDbPath(project, 'list-backups');
    return `litestream ltx ${getLitestreamConfigOption(project, configPath)} "${dbPath}"`;
  }

  restore(project: Project, outputPath: string, configPath?: string): string {
    const dbPath = getAbsoluteSqliteDbPath(project, 'restore');
    return `${buildRemoveSqliteDbCommandForPath(outputPath)}; litestream restore ${getLitestreamConfigOption(project, configPath)} -o "${outputPath}" "${dbPath}"`;
  }

  generate(_project: Project, additionalOptions = ''): string {
    return `YARN drizzle-kit generate ${additionalOptions}`;
  }

  migrateDev(_project: Project, additionalOptions = ''): string {
    return this.generate(_project, additionalOptions);
  }

  seed(project: Project, scriptPath?: string): string {
    if (scriptPath) return `BUN build-ts run ${scriptPath}`;
    if (project.packageJson.scripts?.seed) return 'YARN run seed';
    const defaultSeedPath = path.join('db', 'seed.ts');
    if (fs.existsSync(path.join(project.dirPath, defaultSeedPath))) {
      return project.usesBunPackageManager ? `BUN ${defaultSeedPath}` : `BUN build-ts run ${defaultSeedPath}`;
    }
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
  const dbPath = getSqliteDbPath(project);
  if (!dbPath) return;

  const absolutePath = path.isAbsolute(dbPath) ? dbPath : path.resolve(project.dirPath, dbPath);
  return buildRemoveSqliteDbCommandForPath(absolutePath);
}

function buildRemoveSqliteDbCommandForPath(dbPath: string): string {
  return `rm -f "${dbPath}" "${dbPath}-wal" "${dbPath}-shm"`;
}

function buildRemoveSqliteDbFamilyCommand(dbPath: string): string {
  return `rm -Rf "${dbPath}"*`;
}

function getSqliteDbPathOrError(project: Project, commandName: string): string {
  const dbPath = getSqliteDbPath(project);
  if (!dbPath) {
    throw new Error(`wb db ${commandName} supports Drizzle only when file: DATABASE_URL is set.`);
  }
  return dbPath;
}

function getAbsoluteSqliteDbPath(project: Project, commandName: string): string {
  const dbPath = getSqliteDbPathOrError(project, commandName);
  return path.isAbsolute(dbPath) ? dbPath : path.resolve(project.dirPath, dbPath);
}

function getSqliteDbPath(project: Project): string | undefined {
  return getAbsoluteFileDatabaseUrlPath(project);
}

function getLitestreamConfigOption(project: Project, configPath?: string): string {
  if (configPath) return `-config "${configPath}"`;

  const localConfigPath = path.join(project.dirPath, LITESTREAM_CONFIG_FILE_NAME);
  if (fs.existsSync(localConfigPath)) return `-config ./${LITESTREAM_CONFIG_FILE_NAME}`;
  if (fs.existsSync(DEFAULT_LITESTREAM_CONFIG_PATH)) return `-config ${DEFAULT_LITESTREAM_CONFIG_PATH}`;
  return `-config ./${LITESTREAM_CONFIG_FILE_NAME}`;
}

export const drizzleScripts = new DrizzleScripts();
