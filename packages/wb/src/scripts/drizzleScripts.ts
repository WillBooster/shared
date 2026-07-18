import fs from 'node:fs';
import path from 'node:path';

import { getAbsoluteFileDatabaseUrlPath, isProjectEnvironment, type Project } from '../project.js';
import { buildShellCommand } from '../utils/shell.js';
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
      // Remove only the D1 subtree so that other locally-persisted bindings (KV, R2, Durable Objects) survive,
      // then re-materialize the D1 SQLite file. Its path is deterministic, so a DATABASE_URL exported
      // before the removal stays valid.
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

  deploy(project: Project, additionalOptions = ''): string {
    return buildDrizzleKitCommand(project, `migrate ${additionalOptions}`.trim());
  }

  deployForce(project: Project): string {
    const dbPath = getAbsoluteSqliteDbPath(project, 'deploy-force');
    const removeDbCommand = buildRemoveSqliteDbFamilyCommand(dbPath);
    const litestreamConfigOption = getLitestreamConfigOption(project);
    // The environment assignment must go through buildDrizzleKitCommand: prefixing its
    // possibly-parenthesized result with `ALLOW_TO_SKIP_SEED=0` would be a shell syntax error.
    const migrateWithSeedCommand = buildDrizzleKitCommand(project, 'migrate', 'ALLOW_TO_SKIP_SEED=0');
    return `${removeDbCommand}; ${this.deploy(project)} && ${removeDbCommand}
      && litestream restore ${litestreamConfigOption} -o "${dbPath}" "${dbPath}" && ls -ahl "${dbPath}" && ${migrateWithSeedCommand}`;
  }

  listBackups(project: Project, configPath?: string): string {
    const dbPath = getAbsoluteSqliteDbPath(project, 'list-backups');
    return `litestream ltx ${getLitestreamConfigOption(project, configPath)} "${dbPath}"`;
  }

  restore(project: Project, outputPath: string, configPath?: string): string {
    const dbPath = getAbsoluteSqliteDbPath(project, 'restore');
    return `${buildRemoveSqliteDbCommandForPath(outputPath)}; litestream restore ${getLitestreamConfigOption(project, configPath)} -o "${outputPath}" "${dbPath}"`;
  }

  generate(project: Project, additionalOptions = ''): string {
    return buildDrizzleKitCommand(project, `generate ${additionalOptions}`.trim());
  }

  migrateDev(project: Project, additionalOptions = ''): string {
    return this.generate(project, additionalOptions);
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

  studio(project: Project, dbUrlOrPath?: string, additionalOptions = ''): string {
    if (dbUrlOrPath) {
      return "echo 'wb db studio for Drizzle does not support db-url-or-path.' && exit 1";
    }

    return buildDrizzleKitCommand(project, `studio ${additionalOptions}`.trim());
  }
}

export function buildDrizzleKitCommand(project: Project, args: string, environmentAssignment = ''): string {
  const command = `${environmentAssignment && `${environmentAssignment} `}YARN drizzle-kit ${args}`;
  // A caller-supplied --config resolves against the project directory, so the cwd must stay there.
  return args.includes('--config') ? command : wrapWithDrizzleConfigDir(project, command);
}

export function wrapWithDrizzleConfigDir(project: Project, command: string): string {
  const config = findDrizzleConfig(project);
  // drizzle-kit resolves relative paths in its config against the cwd, so the command must run
  // in the directory containing drizzle.config.* even when monorepo packages share it at the root.
  return config && config.dirPath !== project.dirPath
    ? `(${buildShellCommand(['cd', config.dirPath])} && ${command})`
    : command;
}

// Markers indicating the drizzle config manages a (Cloudflare D1 compatible) SQLite database:
// `dialect: 'sqlite'` covers d1-http and plain SQLite configs, `driver: 'd1-http'` and
// `driver: 'durable-sqlite'` are the explicit D1/Durable Object drivers.
const drizzleSqliteConfigPattern =
  /['"`]?dialect['"`]?\s*:\s*['"`]sqlite['"`]|['"`]?driver['"`]?\s*:\s*['"`](?:d1-http|durable-sqlite)['"`]/;

/**
 * Whether drizzle-kit is the project's D1 migration mechanism. A drizzle-orm dependency alone is
 * not a reliable marker: a Worker may use D1 only for caching while its drizzle config targets an
 * unrelated database (e.g. PostgreSQL via Hyperdrive), and running `drizzle-kit migrate` against
 * that database during a D1 deploy would be wrong (https://github.com/WillBooster/shared/issues/942).
 * So require an explicit marker: a drizzle config whose dialect/driver targets sqlite, d1-http, or
 * durable-sqlite.
 */
export function usesDrizzleKitForD1(project: Project): boolean {
  if (!project.hasDrizzle) return false;

  const config = findDrizzleConfig(project);
  if (!config) return false;

  try {
    const content = stripJsComments(fs.readFileSync(path.join(config.dirPath, config.fileName), 'utf8'));
    // Scan only the exported config's object literal: drizzle-kit consumes the default export,
    // and matching other text (an unused sqlite-shaped constant above the export, or marker-like
    // string content in statements after it) would select the wrong migration mechanism. Configs
    // whose export references an earlier object fall back to scanning from the export marker;
    // wb deploy warns when no mechanism is detected.
    const exportIndices = ['export default', 'module.exports']
      .map((marker) => content.indexOf(marker))
      .filter((index) => index !== -1);
    const exportedContent = exportIndices.length > 0 ? content.slice(Math.min(...exportIndices)) : content;
    return drizzleSqliteConfigPattern.test(extractFirstBalancedObject(exportedContent) ?? exportedContent);
  } catch {
    return false;
  }
}

/** The first `{ ... }` span (string-aware brace matching), or undefined when none exists. */
function extractFirstBalancedObject(content: string): string | undefined {
  const startIndex = content.indexOf('{');
  if (startIndex === -1) return;

  let depth = 0;
  let stringDelimiter: string | undefined;
  for (let index = startIndex; index < content.length; index++) {
    const char = content[index]!;
    if (stringDelimiter) {
      if (char === '\\') index++;
      else if (char === stringDelimiter || (stringDelimiter !== '`' && char === '\n')) stringDelimiter = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') stringDelimiter = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return content.slice(startIndex, index + 1);
  }
  return;
}

/**
 * Remove block and line comments so commented-out markers (e.g. `// dialect: 'sqlite'` in a
 * PostgreSQL config) cannot misclassify the config. The scanner tracks string state, so `//`
 * inside string literals (URLs such as `https://...` in connection strings) survives while
 * comments directly after a string literal are still removed.
 */
function stripJsComments(content: string): string {
  let result = '';
  let stringDelimiter: string | undefined;
  for (let index = 0; index < content.length; index++) {
    const char = content[index]!;
    const nextChar = content[index + 1];
    if (stringDelimiter) {
      if (char === '\\') {
        result += char + (nextChar ?? '');
        index++;
        continue;
      }
      if (char === stringDelimiter || (stringDelimiter !== '`' && char === '\n')) {
        stringDelimiter = undefined;
      }
      result += char;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      stringDelimiter = char;
      result += char;
      continue;
    }
    if (char === '/' && nextChar === '/') {
      while (index < content.length && content[index] !== '\n') index++;
      result += '\n';
      continue;
    }
    if (char === '/' && nextChar === '*') {
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) index++;
      index++;
      continue;
    }
    result += char;
  }
  return result;
}

export function findDrizzleConfig(project: Project): { dirPath: string; fileName: string } | undefined {
  const candidates = ['drizzle.config.ts', 'drizzle.config.mts', 'drizzle.config.js', 'drizzle.config.mjs'];
  for (const dirPath of [project.dirPath, project.rootDirPath]) {
    const fileName = candidates.find((fileName) => fs.existsSync(path.join(dirPath, fileName)));
    if (fileName) return { dirPath, fileName };
  }
  return;
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
