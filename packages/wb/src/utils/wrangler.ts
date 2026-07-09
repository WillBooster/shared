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

export function findWranglerConfigPath(project: Pick<Project, 'dirPath'>): string | undefined {
  for (const fileName of wranglerConfigFileNames) {
    const filePath = path.join(project.dirPath, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }
  return;
}

/**
 * Get the name of the first D1 database declared in the wrangler config file.
 */
export function getD1DatabaseName(project: Pick<Project, 'dirPath'>): string | undefined {
  const configPath = findWranglerConfigPath(project);
  if (!configPath) return;

  const config = fs.readFileSync(configPath, 'utf8');
  // Cover both JSON(C) (`"database_name": "..."`) and TOML (`database_name = "..."`) without full parsers.
  return /["']?database_name["']?\s*[:=]\s*["']([^"']+)["']/u.exec(config)?.[1];
}

/**
 * Build a command materializing the local miniflare D1 SQLite file.
 * A no-op query forces miniflare to create the SQLite file if it doesn't exist yet.
 */
export function buildMaterializeLocalD1Command(databaseName: string): string {
  return `YARN wrangler d1 execute ${databaseName} --local --persist-to "${LOCAL_WRANGLER_STATE_DIR}" --command "SELECT 1" > /dev/null 2>&1`;
}

/**
 * Prefix the given script with commands exporting DATABASE_URL pointing to the local miniflare D1 SQLite file,
 * so that drizzle-kit and seed scripts can operate on the same database as the app.
 * Do nothing if the project has no D1 database in its wrangler config.
 */
export function wrapWithLocalD1DatabaseUrl(project: Pick<Project, 'dirPath'>, script: string): string {
  const databaseName = getD1DatabaseName(project);
  if (!databaseName) return script;

  const exportCommand = `export DATABASE_URL="file:$(ls "${LOCAL_WRANGLER_STATE_DIR}"/v3/d1/miniflare-D1DatabaseObject/*.sqlite | head -1)"`;
  return `${buildMaterializeLocalD1Command(databaseName)} && ${exportCommand} && ${script}`;
}
