import fs from 'node:fs';
import path from 'node:path';

import type { Project } from '../project.js';

const wranglerConfigFileNames = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

/**
 * Local wrangler/miniflare state directory separated per WB_ENV (expanded by the shell at run time),
 * so that e.g. test runs can reset their own D1 database without destroying development state.
 */
// oxlint-disable-next-line no-template-curly-in-string -- expanded by the shell, not by JavaScript
export const LOCAL_WRANGLER_STATE_DIR = '.wrangler/state-${WB_ENV:-development}';

/**
 * Prefix the given script with commands exporting DATABASE_URL pointing to the local miniflare D1 SQLite file,
 * so that drizzle-kit and seed scripts can operate on the same database as the app.
 * Do nothing if the project has no D1 database in its wrangler config.
 */
export function wrapWithLocalD1DatabaseUrl(project: Pick<Project, 'dirPath'>, script: string): string {
  const databaseName = getD1DatabaseName(project);
  if (!databaseName) return script;

  // Excluding miniflare's metadata.sqlite, which lives next to the hash-named database file.
  // An unmatched glob cannot happen here: the script runs under /bin/sh (via Node's `shell: true`),
  // and the preceding materialization command guarantees the SQLite file exists.
  const exportCommand = `export DATABASE_URL="file:$(ls "${LOCAL_WRANGLER_STATE_DIR}"/v3/d1/miniflare-D1DatabaseObject/*.sqlite | grep -v metadata | head -1)"`;
  return `${buildMaterializeLocalD1Command(databaseName)} && ${exportCommand} && ${script}`;
}

/**
 * Get the name of the first D1 database declared in the wrangler config file.
 */
export function getD1DatabaseName(project: Pick<Project, 'dirPath'>): string | undefined {
  const configPath = findWranglerConfigPath(project);
  if (!configPath) return;

  // Cover both JSON(C) (`"database_name": "..."`) and TOML (`database_name = "..."`) without full parsers,
  // skipping commented-out lines so that they cannot shadow the active database name.
  for (const line of fs.readFileSync(configPath, 'utf8').split('\n')) {
    if (/^\s*(?:#|\/\/)/u.test(line)) continue;

    const match = /["']?database_name["']?\s*[:=]\s*["']([^"']+)["']/u.exec(line);
    if (match) return match[1];
  }
  return;
}

export function findWranglerConfigPath(project: Pick<Project, 'dirPath'>): string | undefined {
  for (const fileName of wranglerConfigFileNames) {
    const filePath = path.join(project.dirPath, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }
  return;
}

/**
 * Build a command materializing the local miniflare D1 SQLite file.
 * A no-op query forces miniflare to create the SQLite file if it doesn't exist yet.
 * Only stdout is suppressed; wrangler reports errors on stderr, which must stay visible.
 */
export function buildMaterializeLocalD1Command(databaseName: string): string {
  return `YARN wrangler d1 execute ${databaseName} --local --persist-to "${LOCAL_WRANGLER_STATE_DIR}" --command "SELECT 1" > /dev/null`;
}
