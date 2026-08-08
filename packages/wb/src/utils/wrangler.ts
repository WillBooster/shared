import fs from 'node:fs';
import path from 'node:path';

import type { Project } from '../project.js';
import { buildEnvReaderOptionArgs } from '../sharedOptionsBuilder.js';
import type { ScriptArgv } from '../scripts/builder.js';
import { buildShellCommand } from './shell.js';
import { resolveWranglerConfig, usesWranglerNativeMigrations } from './wranglerConfig.js';

const wranglerConfigFileNames = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

/**
 * Build a command generating a .dev.vars file (via `wb gen-dev-vars`) so that
 * `wrangler dev` can see the wb-managed environment variables.
 */
export function buildGenDevVarsCommand(argv: ScriptArgv, outputPath: string): string {
  return buildShellCommand(['YARN', 'wb', 'gen-dev-vars', ...buildEnvReaderOptionArgs(argv), outputPath]);
}

/**
 * Build a `wrangler dev`-style command. `env -u CLOUDFLARE_ENV` makes wrangler serve the top-level
 * (non-deploy) config. wrangler (like vinext) requires real Node.js — `bun run` respects the bin's
 * node shebang, and wb never composes `--bun` (whose node->bun PATH shim breaks both tools).
 */
export function buildWranglerDevCommand(args: string): string {
  return `env -u CLOUDFLARE_ENV YARN wrangler ${args}`.trim();
}

/**
 * Build commands applying wrangler-native D1 migrations to every selected local binding that has
 * a database name or binding name.
 * CI=true suppresses wrangler's interactive confirmation prompt.
 */
export function buildD1MigrationsApplyCommands(project: Pick<Project, 'dirPath' | 'env'>): string[] {
  return (resolveWranglerConfig(project)?.d1Databases ?? [])
    .filter((database) => usesWranglerNativeMigrations(project, database))
    .flatMap((database) => {
      const databaseName = database.database_name ?? database.binding;
      return databaseName
        ? [
            `env -u CLOUDFLARE_ENV CI=true YARN wrangler d1 migrations apply ${databaseName} --local --persist-to "${getLocalWranglerStateDir(project)}"`,
          ]
        : [];
    });
}

/**
 * Prefix the given script with commands exporting DATABASE_URL pointing to the local miniflare D1 SQLite file,
 * so that drizzle-kit and seed scripts can operate on the same database as the app.
 * Do nothing if the project has no D1 database in its wrangler config.
 */
export function wrapWithLocalD1DatabaseUrl(project: Pick<Project, 'dirPath' | 'env'>, script: string): string {
  const databaseName = getD1DatabaseName(project);
  if (!databaseName) return script;

  // Excluding miniflare's metadata.sqlite, which lives next to the hash-named database file.
  // An unmatched glob cannot happen here: the script runs under /bin/sh (via Node's `shell: true`),
  // and the preceding materialization command guarantees the SQLite file exists.
  // Projects with multiple D1 databases are not supported: the hash-named files cannot be
  // distinguished cheaply (materialization does not even update the target file's mtime).
  // The state directory must be absolute because the wrapped script may `cd` to the monorepo root.
  const stateDirPath = path.resolve(project.dirPath, getLocalWranglerStateDir(project));
  const exportCommand = `export DATABASE_URL="file:$(ls "${stateDirPath}"/v3/d1/miniflare-D1DatabaseObject/*.sqlite | grep -v metadata | head -1)"`;
  return `${buildMaterializeLocalD1Command(project, databaseName)} && ${exportCommand} && ${script}`;
}

/**
 * Get the name of the first D1 database declared in the wrangler config file.
 */
export function getD1DatabaseName(project: Pick<Project, 'dirPath'>): string | undefined {
  const configPath = findWranglerConfigPath(project);
  if (!configPath) return;

  return scanWranglerConfigValue(configPath, 'database_name');
}

// Looked up from many call sites (framework detection, worker-types generation, deploy, test), so
// the existence probes are shared. Keyed on the project OBJECT (not its directory path): the same
// shared Project instance flows through every call site within one invocation, while callers that
// rewrite configs and pass fresh partial objects must observe the current disk state.
const wranglerConfigPathCache = new WeakMap<object, { configPath: string | undefined }>();

export function findWranglerConfigPath(project: Pick<Project, 'dirPath'>): string | undefined {
  // Tests may pass partial Project objects without dirPath.
  if (!project.dirPath) return;
  const cached = wranglerConfigPathCache.get(project);
  if (cached) return cached.configPath;

  const configPath = wranglerConfigFileNames
    .map((fileName) => path.join(project.dirPath, fileName))
    .find((filePath) => fs.existsSync(filePath));
  wranglerConfigPathCache.set(project, { configPath });
  return configPath;
}

/**
 * The first value declared for the key in the wrangler config, covering JSON(C)
 * (`"key": "..."`) and TOML, including its inline-table form (`d1_databases = [{ ..., key = "..." }]`),
 * without full parsers. Commented-out lines are skipped so that they cannot shadow the active
 * value, and the key must follow a line start, `{` or `,` so that prose mentioning it cannot match.
 */
function scanWranglerConfigValue(configPath: string, key: string): string | undefined {
  const keyValuePattern = new RegExp(`(?:^|[,{])\\s*["']?${key}["']?\\s*[:=]\\s*["']([^"']+)["']`, 'u');
  for (const line of fs.readFileSync(configPath, 'utf8').split('\n')) {
    if (/^\s*(?:#|\/\/)/u.test(line)) continue;

    const match = keyValuePattern.exec(line);
    if (match) return match[1];
  }
  return;
}

/**
 * Build a command materializing the local miniflare D1 SQLite file.
 * A no-op query forces miniflare to create the SQLite file if it doesn't exist yet.
 * Only stdout is suppressed; wrangler reports errors on stderr, which must stay visible.
 */
export function buildMaterializeLocalD1Command(project: Pick<Project, 'env'>, databaseName: string): string {
  return `YARN wrangler d1 execute ${databaseName} --local --persist-to "${getLocalWranglerStateDir(project)}" --command "SELECT 1" > /dev/null`;
}

/**
 * Get the local wrangler/miniflare state directory.
 * Development follows wrangler's default directory so that plain `wrangler dev` / `vinext dev`
 * (without a persist-path override) shares the same database as wb-managed db commands.
 * Other environments (e.g. test) get their own directory so that they can be reset
 * without destroying development state.
 */
export function getLocalWranglerStateDir(project: Pick<Project, 'env'>): string {
  // Destructive test resets are gated on isProjectEnvironment(project, 'test'), which accepts
  // either WB_ENV or MISE_ENV; resolve to the test directory whenever either says 'test' so
  // that such resets can never target the development state.
  const wbEnv = [project.env.WB_ENV, project.env.MISE_ENV].includes('test')
    ? 'test'
    : project.env.WB_ENV || project.env.MISE_ENV;
  return !wbEnv || wbEnv === 'development' ? '.wrangler/state' : `.wrangler/state-${wbEnv}`;
}
