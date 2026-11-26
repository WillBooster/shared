import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import type { Project } from '../project.js';

const CLOUDFLARE_CONFIG_FILE_NAME = 'cloudflare.config.ts';
const WRANGLER_CONFIG_FILE_NAMES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

// Runs under real Node.js because cf cannot load `cloudflare.config.ts` on Bun. The loader is
// the one cf itself uses (it understands `cf-worker` import attributes); `@cloudflare/config`
// is a dependency of cf, not of the project, so it is resolved from cf's own location, the way
// cf's imports resolve it (a nested copy wins over one hoisted for another dependent).
// The result goes to a file, because the config may print diagnostics of its own to stdout.
const LOAD_CONFIG_SCRIPT = `
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [configPath, mode, resultPath] = process.argv.slice(1);
const cfPackageJsonPath = realpathSync(createRequire(configPath).resolve('cf/package.json'));
const loaderPackageJsonPath = findPackageJSON('@cloudflare/config', pathToFileURL(cfPackageJsonPath));
const loaderEntry = JSON.parse(readFileSync(loaderPackageJsonPath, 'utf8')).exports['.'].import;
const loaderPath = path.join(path.dirname(loaderPackageJsonPath), loaderEntry);
const { loadAndParseConfig } = await import(pathToFileURL(loaderPath).href);
const { result } = await loadAndParseConfig(configPath, { mode: mode || undefined, isPreview: false });
if (!result.success) throw new Error(JSON.stringify(result.error?.issues ?? result.error ?? result));
writeFileSync(resultPath, JSON.stringify(result.data));
`;

const d1MigrationSettingsSchema = z.object({
  dir: z.string().optional(),
  pattern: z.string().optional(),
  table: z.string().optional(),
});
const parsedConfigSchema = z.looseObject({
  accountId: z.string().optional(),
  worker: z.looseObject({
    name: z.string(),
    env: z.record(z.string(), z.unknown()).optional(),
  }),
});

export interface CloudflareD1Database {
  binding: string;
  name?: string;
  id?: string;
}

export interface D1MigrationSettings {
  dir: string;
  pattern?: string;
  /** The table recording applied migrations, when it is not cf's default. */
  table?: string;
}

export interface CfNativeD1Migration {
  database: CloudflareD1Database;
  settings: D1MigrationSettings;
}

export interface D1Migrations {
  /** D1 bindings migrated with `cf d1 migrations apply`. */
  cfNativeD1Migrations: CfNativeD1Migration[];
  /** The D1 binding migrated with `drizzle-kit migrate`. */
  drizzleD1Database?: CloudflareD1Database;
  errorMessage?: string;
  unmanagedD1Databases: CloudflareD1Database[];
}

export interface ResolvedCloudflareConfig {
  workerName: string;
  accountId?: string;
  /** Values of the `bindings.text()` / `bindings.json()` entries (they count against Cloudflare's limits). */
  vars: Record<string, unknown>;
  /** Names declared with `bindings.secret()`: the only keys a deploy's secrets file may supply. */
  secretNames: string[];
  /** Every key of `worker.env`, whatever its kind. */
  envKeys: string[];
  d1Databases: CloudflareD1Database[];
}

// Keyed on the project OBJECT (not its directory path): the same shared Project instance flows
// through every call site within one invocation, while callers that rewrite configs and pass
// fresh partial objects must observe the current disk state.
const configPathCache = new WeakMap<object, { configPath: string | undefined }>();
const resolvedConfigCache = new WeakMap<object, Map<string, ResolvedCloudflareConfig>>();

export function findCloudflareConfigPath(project: Pick<Project, 'dirPath'>): string | undefined {
  // Tests may pass partial Project objects without dirPath.
  if (!project.dirPath) return;
  return configPathCache.getOrInsertComputed(project, () => {
    const configPath = path.join(project.dirPath, CLOUDFLARE_CONFIG_FILE_NAME);
    return { configPath: fs.existsSync(configPath) ? configPath : undefined };
  }).configPath;
}

/** The wrangler config of a Worker that has not been converted with `cf migrate` yet. */
export function findUnmigratedWranglerConfigPath(project: Pick<Project, 'dirPath'>): string | undefined {
  if (findCloudflareConfigPath(project)) return;
  return WRANGLER_CONFIG_FILE_NAMES.map((fileName) => path.join(project.dirPath, fileName)).find((filePath) =>
    fs.existsSync(filePath)
  );
}

/**
 * The mode wb passes to every cf command, so that a function-form `cloudflare.config.ts`
 * receives WB_ENV as `mode`. Each command entry resolves it once and hands it to the builders.
 * Everything keyed on the environment of a Worker (its config, types, local state directory, and
 * whether that state is disposable test state) follows this one value, so that no two of them
 * can disagree when WB_ENV and MISE_ENV differ. Test wins such a disagreement: a test run inside
 * a shell that also exports a regular WB_ENV must never serve or wipe that environment's state.
 * `wb deploy` does not use it: it passes its validated WB_ENV to every step, its own
 * `gen-code` included.
 */
export function resolveCloudflareMode(project: Pick<Project, 'env'>): string {
  return [project.env.WB_ENV, project.env.MISE_ENV].includes('test')
    ? 'test'
    : project.env.WB_ENV || project.env.MISE_ENV || 'development';
}

/**
 * Evaluate `cloudflare.config.ts` for a local command's mode and return what wb needs from it.
 * Returns undefined when the project has no such config; throws when it cannot be evaluated.
 */
export function resolveLocalCloudflareConfig(
  project: Pick<Project, 'dirPath' | 'env'>,
  mode: string
): ResolvedCloudflareConfig | undefined {
  const configPath = findCloudflareConfigPath(project);
  if (!configPath) return;
  return resolvedConfigCache
    .getOrInsertComputed(project, () => new Map<string, ResolvedCloudflareConfig>())
    .getOrInsertComputed(mode, () => loadCloudflareConfig(project.dirPath, configPath, mode, project.env));
}

/**
 * Evaluate `cloudflare.config.ts` for a deploy, under the environment its build will get: the
 * config may read the environment, so the preflight must see the config the build produces.
 */
export function resolveDeployCloudflareConfig(
  project: Pick<Project, 'dirPath'>,
  envName: string,
  buildEnv: Record<string, string | undefined>
): ResolvedCloudflareConfig | undefined {
  const configPath = findCloudflareConfigPath(project);
  return configPath ? loadCloudflareConfig(project.dirPath, configPath, envName, buildEnv) : undefined;
}

/**
 * The Worker the build wrote to the Build Output, in the shape of the preflight's config, or
 * undefined when the output holds no default Worker.
 */
export function readBuiltCloudflareConfig(project: Pick<Project, 'dirPath'>): ResolvedCloudflareConfig | undefined {
  const outputDirPath = path.join(project.dirPath, '.cloudflare', 'output', 'v1');
  const workerConfigPath = path.join(outputDirPath, 'workers', 'default', 'worker.config.json');
  if (!fs.existsSync(workerConfigPath)) return;
  const rootConfig = z
    .looseObject({ settings: z.looseObject({ accountId: z.string().optional() }).optional() })
    .parse(JSON.parse(fs.readFileSync(path.join(outputDirPath, 'config.json'), 'utf8')));
  return toResolvedConfig({
    accountId: rootConfig.settings?.accountId,
    worker: JSON.parse(fs.readFileSync(workerConfigPath, 'utf8')) as unknown,
  });
}

function loadCloudflareConfig(
  dirPath: string,
  configPath: string,
  mode: string,
  env: Record<string, string | undefined>
): ResolvedCloudflareConfig {
  const resultDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cloudflare-config-'));
  try {
    const resultPath = path.join(resultDirPath, 'config.json');
    const ret = spawnSync('node', ['--input-type=module', '-e', LOAD_CONFIG_SCRIPT, configPath, mode, resultPath], {
      cwd: dirPath,
      encoding: 'utf8',
      // The config may read the environment (e.g. WB_VERSION), exactly as it does under cf.
      env: env as NodeJS.ProcessEnv,
      // The config's own stdout goes to wb's stderr, keeping wb's stdout for its own output.
      stdio: ['ignore', process.stderr.fd, 'pipe'],
    });
    if (ret.status !== 0) {
      throw new Error(
        `Failed to evaluate ${configPath} for mode "${mode}" (is the cf package installed?):\n${(ret.stderr || String(ret.error ?? '')).trim()}`
      );
    }
    if (ret.stderr) process.stderr.write(ret.stderr);
    return toResolvedConfig(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
  } finally {
    fs.rmSync(resultDirPath, { force: true, recursive: true });
  }
}

function toResolvedConfig(rawConfig: unknown): ResolvedCloudflareConfig {
  const config = parsedConfigSchema.parse(rawConfig);
  const resolvedConfig: ResolvedCloudflareConfig = {
    workerName: config.worker.name,
    accountId: config.accountId,
    vars: {},
    secretNames: [],
    envKeys: Object.keys(config.worker.env ?? {}),
    d1Databases: [],
  };
  for (const [key, value] of Object.entries(config.worker.env ?? {})) {
    const binding = z.looseObject({ type: z.string() }).parse(value);
    if (binding.type === 'text' || binding.type === 'json') {
      resolvedConfig.vars[key] = binding.value;
    } else if (binding.type === 'secret') {
      resolvedConfig.secretNames.push(key);
    } else if (binding.type === 'd1') {
      const { id, name } = z.object({ id: z.string().optional(), name: z.string().optional() }).parse(value);
      resolvedConfig.d1Databases.push({ binding: key, id, name });
    }
  }
  return resolvedConfig;
}

export function selectD1Migrations(
  project: Pick<Project, 'dirPath' | 'packageJson'>,
  d1Databases: CloudflareD1Database[],
  drizzleKitManagesD1: boolean
): D1Migrations {
  const cfNativeD1Migrations: CfNativeD1Migration[] = [];
  const otherD1Databases: CloudflareD1Database[] = [];
  for (const database of d1Databases) {
    const settings = findCfNativeD1MigrationSettings(project, database);
    if (settings) {
      cfNativeD1Migrations.push({ database, settings });
    } else {
      otherD1Databases.push(database);
    }
  }
  if (!drizzleKitManagesD1 || otherD1Databases.length === 0) {
    return { cfNativeD1Migrations, unmanagedD1Databases: otherD1Databases };
  }
  // drizzle's generated SQL is not idempotent, so one package must not run both engines.
  const errorMessage =
    cfNativeD1Migrations.length > 0
      ? 'wb does not support mixing cf-native and drizzle-kit D1 migrations in one package.'
      : otherD1Databases.length > 1
        ? 'wb supports drizzle-kit migrations only for a single D1 binding; found multiple.'
        : undefined;
  return errorMessage
    ? { cfNativeD1Migrations, errorMessage, unmanagedD1Databases: [] }
    : { cfNativeD1Migrations, drizzleD1Database: otherD1Databases[0], unmanagedD1Databases: [] };
}

/**
 * How `cf d1 migrations apply` finds the binding's migrations, or undefined when the binding is
 * not migrated that way. `cloudflare.config.ts` has no migration fields, so the explicit opt-in
 * is `"wb": { "d1Migrations": { "<binding>": { "dir", "pattern", "table" } } }` in package.json
 * (e.g. for drizzle-kit's nested `<dir>/<name>/migration.sql` layout); without an entry, flat
 * `*.sql` files in `migrations/` (cf's defaults) opt in. A drizzle-kit `out` directory with
 * nested files and no explicit pattern would match nothing and silently apply zero migrations,
 * so it must fall through to the drizzle-kit mechanism.
 */
export function findCfNativeD1MigrationSettings(
  project: Pick<Project, 'dirPath' | 'packageJson'>,
  database: CloudflareD1Database
): D1MigrationSettings | undefined {
  const explicitSettings = z
    .looseObject({ d1Migrations: z.record(z.string(), d1MigrationSettingsSchema).optional() })
    .optional()
    .parse((project.packageJson as { wb?: unknown }).wb)?.d1Migrations?.[database.binding];
  // An explicit entry opts in even before the directory exists; cf then fails safely instead
  // of wb silently switching to a different migration engine.
  if (explicitSettings) return { ...explicitSettings, dir: explicitSettings.dir ?? 'migrations' };

  const migrationsDirPath = path.resolve(project.dirPath, 'migrations');
  if (!fs.existsSync(migrationsDirPath)) return;
  return fs.readdirSync(migrationsDirPath).some((fileName) => fileName.endsWith('.sql'))
    ? { dir: 'migrations' }
    : undefined;
}

export function formatD1DatabaseNames(d1Databases: CloudflareD1Database[]): string {
  return d1Databases.map((database) => database.binding).join(', ');
}
