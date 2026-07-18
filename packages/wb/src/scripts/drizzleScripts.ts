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
    // string content in statements after it) would select the wrong migration mechanism.
    // POSITIONS (export markers, declarations) are located on a string-masked view of the same
    // length, so `export default` inside a string literal cannot mislead the search.
    const maskedContent = maskStringContents(content);
    const exportIndices = ['export default', 'module.exports']
      .map((marker) => maskedContent.indexOf(marker))
      .filter((index) => index !== -1);
    const exportStartIndex = exportIndices.length > 0 ? Math.min(...exportIndices) : 0;
    const objectSpan = extractExportedConfigObject(content, maskedContent, exportStartIndex);
    return objectSpan !== undefined && declaresSqliteTarget(objectSpan);
  } catch {
    return false;
  }
}

/**
 * The object literal the export actually evaluates to: for `export default {...}` or
 * `export default defineConfig({...})` the first balanced object after the marker, and for
 * `export default config;` the initializer of that identifier's declaration — never the whole
 * file, since an unrelated object (e.g. an unused sqlite-shaped constant) must not be selected.
 * Undefined when the expression cannot be resolved; wb deploy's unmanaged-D1 warning covers that.
 */
function extractExportedConfigObject(
  content: string,
  maskedContent: string,
  exportStartIndex: number
): string | undefined {
  const exportedExpression = maskedContent
    .slice(exportStartIndex)
    .replace(/^(?:export\s+default|module\.exports\s*=)\s*/, '');
  // An identifier export may carry a TypeScript type postfix (`config satisfies Config;` /
  // `config as Config;`); the identifier is recognized FIRST so a postfix containing a TYPE
  // literal (`satisfies { dialect: 'sqlite' | ... }`) is never mistaken for the runtime config.
  const identifierMatch = /^([A-Za-z_$][\w$]*)\s*(?:satisfies\b|as\b|;|\n|$)/.exec(exportedExpression);
  if (!identifierMatch) {
    const braceOffset = maskedContent.slice(exportStartIndex).indexOf('{');
    if (braceOffset === -1) return;
    return extractFirstBalancedObject(content.slice(exportStartIndex + braceOffset));
  }

  // `$` is legal in identifiers but a regex anchor, so it must be escaped before interpolation;
  // `(?![\w$])` (not `\b`) ends the match because `\b` never fires after a trailing `$`.
  const escapedIdentifier = identifierMatch[1]!.replaceAll('$', String.raw`\$`);
  const declarationEndIndex = findModuleScopeDeclarationEnd(maskedContent, escapedIdentifier);
  if (declarationEndIndex === undefined) return;
  // The initializer must belong to THIS declaration (a type annotation may precede the `=`); an
  // uninitialized `let config;` stays unresolved instead of grabbing a later statement's `=`.
  const assignmentMatch = /^\s*(?::[^=;\n]*)?=/.exec(maskedContent.slice(declarationEndIndex));
  if (!assignmentMatch) return;
  return extractFirstBalancedObject(content.slice(declarationEndIndex + assignmentMatch[0].length));
}

/**
 * The end index of the identifier's declaration at brace depth ZERO (module scope): a same-named
 * declaration inside a function body must not shadow the binding the export references, and
 * indentation is no scope signal — depth over the string-masked content is.
 */
function findModuleScopeDeclarationEnd(maskedContent: string, escapedIdentifier: string): number | undefined {
  const declarationRegex = new RegExp(
    String.raw`(?<![\w$])(?:export\s+)?(?:const|let|var)\s+${escapedIdentifier}(?![\w$])`,
    'g'
  );
  let depth = 0;
  let scanIndex = 0;
  for (let match = declarationRegex.exec(maskedContent); match; match = declarationRegex.exec(maskedContent)) {
    for (; scanIndex < match.index; scanIndex++) {
      const char = maskedContent[scanIndex];
      if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    if (depth === 0) return match.index + match[0].length;
  }
  return;
}

/**
 * Replace the CONTENTS of string literals with spaces (same length, newlines kept), so position
 * searches over the result cannot match text inside strings while all indexes still map 1:1 to
 * the original content.
 */
function maskStringContents(content: string): string {
  let result = '';
  let stringDelimiter: string | undefined;
  for (let index = 0; index < content.length; index++) {
    const char = content[index]!;
    if (stringDelimiter) {
      if (char === '\\') {
        result += '  ';
        index++;
        continue;
      }
      if (char === stringDelimiter || (stringDelimiter !== '`' && char === '\n')) {
        stringDelimiter = undefined;
        result += char;
        continue;
      }
      result += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') stringDelimiter = char;
    result += char;
  }
  return result;
}

/**
 * String-aware scan for the markers indicating the config manages a (Cloudflare D1 compatible)
 * SQLite database — a `dialect: 'sqlite'`, `driver: 'd1-http'`, or `driver: 'durable-sqlite'`
 * PROPERTY (plain or quoted key). Keys are only recognized in code position, so marker-like text
 * embedded in unrelated string values (e.g. a schema path) cannot match.
 */
function declaresSqliteTarget(content: string): boolean {
  const tokens = tokenizeStrings(content);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    let key: string | undefined;
    let valueTokenIndex: number | undefined;
    if (token.type === 'code') {
      const match = /(?:^|[\s{,(])(dialect|driver)\s*:\s*$/.exec(token.value);
      if (match) {
        key = match[1];
        valueTokenIndex = index + 1;
      }
    } else if (token.value === 'dialect' || token.value === 'driver') {
      // A quoted key: the surrounding code tokens must form a property position (`{`/`,` before,
      // `:` after).
      const previousToken = tokens[index - 1];
      const nextToken = tokens[index + 1];
      if (
        previousToken?.type === 'code' &&
        /[{,(]\s*$/.test(previousToken.value) &&
        nextToken?.type === 'code' &&
        /^\s*:\s*$/.test(nextToken.value)
      ) {
        key = token.value;
        valueTokenIndex = index + 2;
      }
    }
    if (key === undefined || valueTokenIndex === undefined) continue;

    const valueToken = tokens[valueTokenIndex];
    if (valueToken?.type !== 'string') continue;
    if (key === 'dialect' && valueToken.value === 'sqlite') return true;
    if (key === 'driver' && (valueToken.value === 'd1-http' || valueToken.value === 'durable-sqlite')) return true;
  }
  return false;
}

/**
 * Split into alternating code and string-literal-content tokens (quotes excluded). The input is
 * already comment-free — usesDrizzleKitForD1 runs stripJsComments before any scanning — so
 * comment delimiters need no handling here (a commented-out `// dialect: 'sqlite'` can never
 * reach this tokenizer).
 */
function tokenizeStrings(content: string): { type: 'code' | 'string'; value: string }[] {
  const tokens: { type: 'code' | 'string'; value: string }[] = [];
  let code = '';
  for (let index = 0; index < content.length; index++) {
    const char = content[index]!;
    if (char === "'" || char === '"' || char === '`') {
      tokens.push({ type: 'code', value: code });
      code = '';
      let value = '';
      index++;
      while (index < content.length && content[index] !== char) {
        if (content[index] === '\\') index++;
        value += content[index] ?? '';
        index++;
      }
      tokens.push({ type: 'string', value });
      continue;
    }
    code += char;
  }
  tokens.push({ type: 'code', value: code });
  return tokens;
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
