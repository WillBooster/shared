import fs from 'node:fs';
import path from 'node:path';

import type { ParseError } from 'jsonc-parser';
import { parse } from 'jsonc-parser';

import type { Project } from '../project.js';

import { findWranglerConfigPath } from './wrangler.js';

export interface WranglerD1Database {
  binding?: string;
  database_name?: string;
  database_id?: string;
  migrations_dir?: string;
  migrations_pattern?: string;
}

/**
 * Whether the D1 binding uses wrangler-native migrations that `wrangler d1 migrations apply`
 * would actually discover: an explicit `migrations_pattern` opts in, otherwise the migrations
 * directory must contain flat `*.sql` files (wrangler's default pattern). A drizzle-kit `out`
 * directory with nested `<name>/migration.sql` files and no pattern would match nothing and
 * silently apply zero migrations, so it must fall through to the drizzle-kit mechanism.
 */
export function usesWranglerNativeMigrations(project: Pick<Project, 'dirPath'>, database: WranglerD1Database): boolean {
  const migrationsDirPath = path.resolve(project.dirPath, database.migrations_dir ?? 'migrations');
  if (!fs.existsSync(migrationsDirPath)) return false;
  if (database.migrations_pattern) return true;
  return fs.readdirSync(migrationsDirPath).some((fileName) => fileName.endsWith('.sql'));
}

const NAME_KEYED_BINDING_PARENTS = new Set(['bindings', 'send_email', 'ratelimits']);
const RECORD_KEYED_BINDING_KEYS = new Set(['wasm_modules', 'text_blobs', 'data_blobs']);

/**
 * Collect every binding name declared in the (environment-resolved) config subtree: `binding`
 * properties anywhere (D1, KV, R2, services, assets, queues, etc.), the `name`-keyed bindings
 * (`durable_objects.bindings`, `logfwdr.bindings`, `send_email`, `ratelimits`), and the
 * record-keyed legacy module bindings (`wasm_modules`, `text_blobs`, `data_blobs`). A secret
 * sharing a binding's name would silently replace that binding with a plain string on deploy.
 */
export function collectBindingNames(value: unknown, names = new Set<string>(), parentKey = ''): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectBindingNames(item, names, parentKey);
    return names;
  }
  if (!value || typeof value !== 'object') return names;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'binding' && typeof child === 'string') {
      names.add(child);
    } else if (key === 'name' && typeof child === 'string' && NAME_KEYED_BINDING_PARENTS.has(parentKey)) {
      names.add(child);
    } else if (RECORD_KEYED_BINDING_KEYS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
      for (const bindingName of Object.keys(child)) names.add(bindingName);
    } else if (key !== 'env' && key !== 'vars' && key !== 'metadata' && key !== 'options') {
      // Nested `env` subtrees belong to other environments; `vars` values, `unsafe.metadata`,
      // and `unsafe.bindings[].dev.options` are arbitrary JSON whose properties (e.g. a
      // "binding" field) are data, not Worker bindings.
      collectBindingNames(child, names, key);
    }
  }
  return names;
}

export interface ResolvedWranglerConfig {
  /** The Worker name for the deploy environment (wrangler appends `-<env>` when the env section has no own name). */
  workerName?: string;
  accountId?: string;
  varKeys: string[];
  /** The environment's `vars` values (needed for Cloudflare's combined count/size limits). */
  vars: Record<string, unknown>;
  /** Names of all non-var bindings (D1, KV, R2, Durable Objects, send_email, services, ...). */
  bindingNames: string[];
  d1Databases: WranglerD1Database[];
  /**
   * Whether the environment comes from an `env.<name>` section (then wrangler commands need
   * `--env <name>` / `CLOUDFLARE_ENV=<name>`). `production` may be either the top level or a
   * named `env.production` section; the section wins when it exists.
   */
  usesEnvSection: boolean;
}

interface RawWranglerConfig {
  name?: string;
  account_id?: string;
  vars?: Record<string, unknown>;
  d1_databases?: WranglerD1Database[];
  assets?: unknown;
  logfwdr?: unknown;
  env?: Record<string, RawWranglerConfig>;
}

/**
 * Resolve the wrangler config values needed for deploying to the given environment.
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

  // jsonc-parser is fault tolerant and would return a partial object for malformed input,
  // which could migrate a remote database from a half-read config; reject any parse error.
  const parseErrors: ParseError[] = [];
  const config = parse(fs.readFileSync(configPath, 'utf8'), parseErrors, {
    allowTrailingComma: true,
  }) as RawWranglerConfig | undefined;
  if (parseErrors.length > 0) {
    throw new Error(`Failed to parse ${configPath}: ${parseErrors.length} JSONC syntax error(s).`);
  }
  if (!config) return;

  const envConfig = config.env?.[envName];
  if (!envConfig && envName !== 'production') {
    throw new Error(`The wrangler config has no "env": { "${envName}": ... } section.`);
  }
  return envConfig
    ? {
        workerName: envConfig.name ?? (config.name ? `${config.name}-${envName}` : undefined),
        accountId: envConfig.account_id ?? config.account_id,
        varKeys: Object.keys(envConfig.vars ?? {}),
        vars: envConfig.vars ?? {},
        // Most bindings are non-inheritable and must be redeclared per environment, so only the
        // environment's own names count — plus the genuinely inherited shapes (assets, logfwdr),
        // which wrangler resolves as whole fields: the environment's own field overrides the
        // top level entirely, so only the effective value's names count.
        bindingNames: [
          ...collectBindingNames(
            { assets: envConfig.assets ?? config.assets, logfwdr: envConfig.logfwdr ?? config.logfwdr },
            collectBindingNames(envConfig)
          ),
        ],
        d1Databases: envConfig.d1_databases ?? [],
        usesEnvSection: true,
      }
    : {
        workerName: config.name,
        accountId: config.account_id,
        varKeys: Object.keys(config.vars ?? {}),
        vars: config.vars ?? {},
        bindingNames: [...collectBindingNames(config)],
        d1Databases: config.d1_databases ?? [],
        usesEnvSection: false,
      };
}
