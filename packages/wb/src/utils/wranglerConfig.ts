import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'jsonc-parser';

import type { Project } from '../project.js';

import { findWranglerConfigPath } from './wrangler.js';

export interface WranglerD1Database {
  binding?: string;
  database_name?: string;
  database_id?: string;
}

export interface ResolvedWranglerConfig {
  /** The Worker name for the deploy environment (wrangler appends `-<env>` when the env section has no own name). */
  workerName?: string;
  accountId?: string;
  varKeys: string[];
  d1Databases: WranglerD1Database[];
}

interface RawWranglerConfig {
  name?: string;
  account_id?: string;
  vars?: Record<string, unknown>;
  d1_databases?: WranglerD1Database[];
  env?: Record<string, RawWranglerConfig>;
}

/**
 * Resolve the wrangler config values needed for deploying to the given environment
 * ('production' means the top-level config; anything else reads the `env.<name>` section).
 * Follows wrangler's inheritance rules: `account_id` is inherited by named environments,
 * while `vars` and `d1_databases` are not and must be redeclared per environment.
 */
export function resolveWranglerConfigForEnv(
  project: Pick<Project, 'dirPath'>,
  envName: string
): ResolvedWranglerConfig | undefined {
  const configPath = findWranglerConfigPath(project);
  if (!configPath) return;
  if (path.extname(configPath) === '.toml') {
    throw new Error('wb deploy supports wrangler.jsonc/wrangler.json configs only; migrate wrangler.toml first.');
  }

  const config = parse(fs.readFileSync(configPath, 'utf8')) as RawWranglerConfig | undefined;
  if (!config) return;

  const isProduction = envName === 'production';
  const envConfig = isProduction ? config : config.env?.[envName];
  if (!isProduction && !envConfig) {
    throw new Error(`The wrangler config has no "env": { "${envName}": ... } section.`);
  }
  return {
    workerName: isProduction
      ? config.name
      : (envConfig?.name ?? (config.name ? `${config.name}-${envName}` : undefined)),
    accountId: envConfig?.account_id ?? config.account_id,
    varKeys: Object.keys(envConfig?.vars ?? {}),
    d1Databases: envConfig?.d1_databases ?? [],
  };
}
