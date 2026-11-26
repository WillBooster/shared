import path from 'node:path';

import type { Project } from '../project.js';
import type { ScriptArgv } from '../scripts/builder.js';
import { buildEnvReaderOptionArgs } from '../sharedOptionsBuilder.js';
import type { CfNativeD1Migration, CloudflareD1Database, D1MigrationSettings } from './cloudflareConfig.js';
import { resolveLocalCloudflareConfig } from './cloudflareConfig.js';
import { buildShellCommand, shellEscapeArgument } from './shell.js';

/**
 * Build a command generating the mode's `.dev.vars.<mode>` file (via `wb gen-dev-vars`) so that a
 * locally served Worker can see the wb-managed values of its declared secrets. The local runtime
 * prefers that file over `.dev.vars`, so servers of different modes (a dev server and a test
 * run) never rewrite each other's file.
 */
export function buildGenDevVarsCommand(argv: ScriptArgv): string {
  return buildShellCommand(['YARN', 'wb', 'gen-dev-vars', ...buildEnvReaderOptionArgs(argv)]);
}

/**
 * Build a cf command for the mode its command entry resolved. cf requires real Node.js:
 * `bun run` respects the bin's node shebang, and wb never composes `--bun` (whose node->bun PATH
 * shim breaks cf).
 */
export function buildCfCommand(mode: string, command: string, args = ''): string {
  return `YARN cf ${command} --mode ${shellEscapeArgument(mode)} ${args}`.trim();
}

/**
 * Build commands applying the given cf-native D1 migrations to the local state directory.
 * CI=true suppresses cf's interactive confirmation prompt.
 */
export function buildLocalD1MigrationsApplyCommands(
  project: Pick<Project, 'dirPath' | 'env'>,
  mode: string,
  cfNativeD1Migrations: CfNativeD1Migration[]
): string[] {
  return cfNativeD1Migrations.map(
    ({ database, settings }) =>
      `CI=true ${buildCfCommand(mode, 'd1 migrations apply', `${getD1DatabaseId(database)} --local --persist-to "${getLocalStateDir(project, mode)}" ${buildD1MigrationOptions(settings)}`)}`
  );
}

export function buildD1MigrationOptions({ dir, pattern, table }: D1MigrationSettings): string {
  return buildShellCommand([
    '--dir',
    dir,
    ...(pattern ? ['--pattern', pattern] : []),
    ...(table ? ['--table', table] : []),
  ]);
}

/**
 * Prefix the given script with commands exporting DATABASE_URL pointing to the local miniflare D1 SQLite file,
 * so that drizzle-kit and seed scripts can operate on the same database as the app.
 * Do nothing if the project has no D1 binding in its Cloudflare config.
 */
export function wrapWithLocalD1DatabaseUrl(
  project: Pick<Project, 'dirPath' | 'env'>,
  mode: string,
  script: string
): string {
  const database = findLocalD1Database(project, mode);
  if (!database) return script;

  // Excluding miniflare's metadata.sqlite, which lives next to the hash-named database file.
  // An unmatched glob cannot happen here: the script runs under /bin/sh (via Node's `shell: true`),
  // and the preceding materialization command guarantees the SQLite file exists.
  // Projects with multiple D1 databases are not supported: the hash-named files cannot be
  // distinguished cheaply (materialization does not even update the target file's mtime).
  const exportCommand = `export DATABASE_URL="file:$(ls "${getAbsoluteLocalStateDir(project, mode)}"/v3/d1/miniflare-D1DatabaseObject/*.sqlite | grep -v '/metadata[.]sqlite$' | head -1)"`;
  // The drizzle config takes its remote target from CLOUDFLARE_D1_DATABASE_ID, which wb sets only
  // for a remote migration, so an exported one must not turn this local command into a remote one.
  // The subshell keeps both changes from reaching the commands after it (e.g. the server).
  return `(${buildMaterializeLocalD1Command(project, mode, database)} && unset CLOUDFLARE_D1_DATABASE_ID && ${exportCommand} && ${script})`;
}

/** The first D1 binding of the mode. */
export function findLocalD1Database(
  project: Pick<Project, 'dirPath' | 'env'>,
  mode: string
): CloudflareD1Database | undefined {
  return resolveLocalCloudflareConfig(project, mode)?.d1Databases[0];
}

/**
 * Build a command materializing the local miniflare D1 SQLite file.
 * A no-op query forces miniflare to create the SQLite file if it doesn't exist yet.
 * Only stdout is suppressed; cf reports errors on stderr, which must stay visible.
 */
export function buildMaterializeLocalD1Command(
  project: Pick<Project, 'env'>,
  mode: string,
  database: CloudflareD1Database
): string {
  return `${buildCfCommand(mode, 'd1 raw', `${getD1DatabaseId(database)} --local --persist-to "${getLocalStateDir(project, mode)}" --sql "SELECT 1"`)} > /dev/null`;
}

/**
 * The ID cf's D1 commands take. Local simulations key a database on the same ID as the served
 * Worker's binding, so a binding without one (auto-provisioned on deploy) cannot be addressed.
 */
export function getD1DatabaseId(database: CloudflareD1Database): string {
  if (!database.id) {
    throw new Error(`The D1 binding ${database.binding} has no id in cloudflare.config.ts.`);
  }
  if (!CF_D1_DATABASE_ID_PATTERN.test(database.id)) {
    throw new Error(
      `The id of the D1 binding ${database.binding} in cloudflare.config.ts is not a version 4 UUID, which cf's D1 commands require: ${database.id}`
    );
  }
  return database.id;
}

// The forms cf's D1 commands accept, so that a deploy rejects a mistyped id before its first
// migration instead of at the migration of that binding.
const CF_D1_DATABASE_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{32})$/iu;

/**
 * Get the local miniflare state directory: the absolute `WB_CLOUDFLARE_STATE_DIR` when the caller
 * exports one (an isolated instance, which wb never wipes), else the mode's own directory.
 * Development follows cf's default directory so that plain `cf dev` and `cf ... --local`
 * (without a persist-path override) share the same data as wb-managed commands.
 * Other modes (e.g. test) get their own directory so that they can be reset
 * without destroying development state.
 */
export function getLocalStateDir(project: Pick<Project, 'env'>, mode: string): string {
  const chosenStateDir = getChosenLocalStateDir(project);
  if (chosenStateDir) return chosenStateDir;
  return mode === 'development' ? '.cloudflare/state' : `.cloudflare/state-${mode}`;
}

/** Absolute, because a consumer (a wrapped script, Vite) may run from another directory. */
export function getAbsoluteLocalStateDir(project: Pick<Project, 'dirPath' | 'env'>, mode: string): string {
  return path.resolve(project.dirPath, getLocalStateDir(project, mode));
}

const PLAIN_PATH_PATTERN = /^[\w./@+-]+$/u;

/**
 * The state directory the caller chose by exporting `WB_CLOUDFLARE_STATE_DIR`, or undefined.
 * It must be absolute, because wb and the commands it runs resolve paths from different
 * directories, and plain, because wb embeds it in shell scripts whose quoting and normalization
 * (see normalizeScript) would otherwise turn it into another directory, which a reset deletes.
 */
export function getChosenLocalStateDir(project: Pick<Project, 'env'>): string | undefined {
  const stateDir = project.env.WB_CLOUDFLARE_STATE_DIR;
  if (!stateDir) return;
  if (!path.isAbsolute(stateDir) || !PLAIN_PATH_PATTERN.test(stateDir)) {
    throw new Error(
      `WB_CLOUDFLARE_STATE_DIR must be an absolute path of letters, digits, and "_.@+-/" only: ${stateDir}`
    );
  }
  // Resolved lexically, as cf resolves --persist-to, so that `rm` (which follows a symlink before
  // `..`) deletes the directory cf migrates.
  return path.resolve(stateDir);
}

/**
 * Gives an isolated instance (one on a chosen state directory) the given port and the origin
 * derived from it, whatever the fnox profile pins or the caller inherited. Every wb process of the
 * instance, including nested ones such as `wb concurrently`, reloads its environment, where off CI
 * a forced mode's fnox profile overrides exported values; the port therefore also travels in
 * WB_ISOLATED_INSTANCE_PORT, which each of them applies again (see Project.env). Only wb sets
 * that variable, so a later command run from the caller's shell (e.g. a deploy) is unaffected.
 */
export function applyIsolatedInstancePort(env: Record<string, string | undefined>, port: string): void {
  env.WB_ISOLATED_INSTANCE_PORT = port;
  env.PORT = port;
  env.NEXT_PUBLIC_BASE_URL = `http://localhost:${port}`;
}

/** A `wb db` reset of a chosen state directory removes its whole D1 state, so it serves one package. */
export function assertSingleProjectForChosenStateDir(projects: Pick<Project, 'env' | 'name'>[]): void {
  if (projects.length > 1 && projects.some((project) => getChosenLocalStateDir(project))) {
    throw new Error(
      `WB_CLOUDFLARE_STATE_DIR serves one package; run the command in one of ${projects.map(({ name }) => name).join(', ')}.`
    );
  }
}
