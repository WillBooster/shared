import path from 'node:path';

import type { Project } from '../project.js';
import type { ScriptArgv } from '../scripts/builder.js';
import { buildEnvReaderOptionArgs } from '../sharedOptionsBuilder.js';
import type { CloudflareD1Database, D1MigrationSettings } from './cloudflareConfig.js';
import { resolveLocalCloudflareConfig, selectD1Migrations } from './cloudflareConfig.js';
import { buildShellCommand, shellEscapeArgument } from './shell.js';

type CloudflareProject = Pick<Project, 'dirPath' | 'env' | 'packageJson'>;

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
 * Build commands applying cf-native D1 migrations to every local D1 binding.
 * CI=true suppresses cf's interactive confirmation prompt.
 */
export function buildLocalD1MigrationsApplyCommands(
  project: CloudflareProject,
  mode: string,
  drizzleKitManagesD1: boolean
): string[] {
  const { cfNativeD1Migrations, errorMessage } = selectD1Migrations(
    project,
    resolveLocalCloudflareConfig(project, mode)?.d1Databases ?? [],
    drizzleKitManagesD1
  );
  if (errorMessage) throw new Error(errorMessage);
  return cfNativeD1Migrations.map(
    ({ database, settings }) =>
      `CI=true ${buildCfCommand(mode, 'd1 migrations apply', `${getD1DatabaseId(database)} --local --persist-to "${getLocalStateDir(mode)}" ${buildD1MigrationOptions(settings)}`)}`
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
  const exportCommand = `export DATABASE_URL="file:$(ls "${getAbsoluteLocalStateDir(project, mode)}"/v3/d1/miniflare-D1DatabaseObject/*.sqlite | grep -v metadata | head -1)"`;
  return `${buildMaterializeLocalD1Command(mode, database)} && ${exportCommand} && ${script}`;
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
export function buildMaterializeLocalD1Command(mode: string, database: CloudflareD1Database): string {
  return `${buildCfCommand(mode, 'd1 raw', `${getD1DatabaseId(database)} --local --persist-to "${getLocalStateDir(mode)}" --sql "SELECT 1"`)} > /dev/null`;
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
 * Get the local miniflare state directory of the mode.
 * Development follows cf's default directory so that plain `cf dev` and `cf ... --local`
 * (without a persist-path override) share the same data as wb-managed commands.
 * Other modes (e.g. test) get their own directory so that they can be reset
 * without destroying development state.
 */
export function getLocalStateDir(mode: string): string {
  return mode === 'development' ? '.cloudflare/state' : `.cloudflare/state-${mode}`;
}

/** Absolute, because a consumer (a wrapped script, Vite) may run from another directory. */
export function getAbsoluteLocalStateDir(project: Pick<Project, 'dirPath'>, mode: string): string {
  return path.resolve(project.dirPath, getLocalStateDir(mode));
}
