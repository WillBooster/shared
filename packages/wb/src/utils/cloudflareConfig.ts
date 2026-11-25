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
// is a dependency of cf, not of the project, so it is resolved beside the installed cf package.
// The result goes to a file, because the config may print diagnostics of its own to stdout.
const LOAD_CONFIG_SCRIPT = `
import { realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [configPath, mode, resultPath] = process.argv.slice(1);
const cfPackageJsonPath = realpathSync(createRequire(configPath).resolve('cf/package.json'));
const loaderPath = path.join(path.dirname(cfPackageJsonPath), '..', '@cloudflare', 'config', 'dist', 'index.mjs');
const { loadAndParseConfig } = await import(pathToFileURL(loaderPath).href);
const { result } = await loadAndParseConfig(configPath, { mode: mode || undefined, isPreview: false });
if (!result.success) throw new Error(JSON.stringify(result.error?.issues ?? result.error ?? result));
writeFileSync(resultPath, JSON.stringify(result.data));
`;

const d1MigrationSettingsSchema = z.object({ dir: z.string().optional(), pattern: z.string().optional() });
const parsedConfigSchema = z.looseObject({
  accountId: z.string().optional(),
  containers: z.array(z.unknown()).optional(),
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
}

export interface D1Migrations {
  /** D1 bindings migrated with `cf d1 migrations apply`. */
  cfNativeD1Databases: CloudflareD1Database[];
  cfNativeSettings?: D1MigrationSettings;
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
  /** Names declared with `bindings.secret()`: the only keys a secrets file or `.dev.vars` may supply. */
  secretNames: string[];
  /** Every key of `worker.env`, whatever its kind. */
  envKeys: string[];
  d1Databases: CloudflareD1Database[];
  hasContainers: boolean;
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
 * receives WB_ENV as `mode`.
 */
export function getCloudflareMode(project: Pick<Project, 'env'>): string {
  // Destructive test resets are gated on isProjectEnvironment(project, 'test'), which accepts
  // either WB_ENV or MISE_ENV; resolve to test whenever either says so, so that such resets can
  // never target the development state.
  return [project.env.WB_ENV, project.env.MISE_ENV].includes('test')
    ? 'test'
    : project.env.WB_ENV || project.env.MISE_ENV || 'development';
}

/**
 * Evaluate `cloudflare.config.ts` for the mode and return what wb needs from it. Returns
 * undefined when the project has no such config; throws when it cannot be evaluated.
 */
export function resolveCloudflareConfig(
  project: Pick<Project, 'dirPath' | 'env'>,
  mode = getCloudflareMode(project)
): ResolvedCloudflareConfig | undefined {
  const configPath = findCloudflareConfigPath(project);
  if (!configPath) return;
  return resolvedConfigCache
    .getOrInsertComputed(project, () => new Map<string, ResolvedCloudflareConfig>())
    .getOrInsertComputed(mode, () => loadCloudflareConfig(project, configPath, mode));
}

function loadCloudflareConfig(
  project: Pick<Project, 'dirPath' | 'env'>,
  configPath: string,
  mode: string
): ResolvedCloudflareConfig {
  const resultDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cloudflare-config-'));
  let config;
  try {
    const resultPath = path.join(resultDirPath, 'config.json');
    const ret = spawnSync('node', ['--input-type=module', '-e', LOAD_CONFIG_SCRIPT, configPath, mode, resultPath], {
      cwd: project.dirPath,
      encoding: 'utf8',
      // The config may read the environment (e.g. WB_VERSION), exactly as it does under cf.
      env: project.env as NodeJS.ProcessEnv,
      // The config's own stdout goes to wb's stderr, keeping wb's stdout for its own output.
      stdio: ['ignore', process.stderr.fd, 'pipe'],
    });
    if (ret.status !== 0) {
      throw new Error(
        `Failed to evaluate ${configPath} for mode "${mode}" (is the cf package installed?):\n${(ret.stderr || String(ret.error ?? '')).trim()}`
      );
    }
    if (ret.stderr) process.stderr.write(ret.stderr);
    config = parsedConfigSchema.parse(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
  } finally {
    fs.rmSync(resultDirPath, { force: true, recursive: true });
  }
  const resolvedConfig: ResolvedCloudflareConfig = {
    workerName: config.worker.name,
    accountId: config.accountId,
    vars: {},
    secretNames: [],
    envKeys: Object.keys(config.worker.env ?? {}),
    d1Databases: [],
    hasContainers: (config.containers?.length ?? 0) > 0,
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

/**
 * How `cf d1 migrations apply` finds the package's migrations, or undefined when the package
 * does not migrate D1 that way. `cloudflare.config.ts` has no migration fields, so the explicit
 * opt-in is `"wb": { "d1Migrations": { "dir": ..., "pattern": ... } }` in package.json (e.g. for
 * drizzle-kit's nested `<dir>/<name>/migration.sql` layout); without it, flat `*.sql` files in
 * `migrations/` (cf's defaults) opt in. A drizzle-kit `out` directory with nested files and no
 * explicit pattern would match nothing and silently apply zero migrations, so it must fall
 * through to the drizzle-kit mechanism.
 */
export function findCfNativeD1MigrationSettings(
  project: Pick<Project, 'dirPath' | 'packageJson'>
): D1MigrationSettings | undefined {
  const explicitSettings = z
    .looseObject({ d1Migrations: d1MigrationSettingsSchema.optional() })
    .optional()
    .parse((project.packageJson as { wb?: unknown }).wb)?.d1Migrations;
  // An explicit setting opts in even before the directory exists; cf then fails safely instead
  // of wb silently switching to a different migration engine.
  if (explicitSettings) return { dir: explicitSettings.dir ?? 'migrations', pattern: explicitSettings.pattern };

  const migrationsDirPath = path.resolve(project.dirPath, 'migrations');
  if (!fs.existsSync(migrationsDirPath)) return;
  return fs.readdirSync(migrationsDirPath).some((fileName) => fileName.endsWith('.sql'))
    ? { dir: 'migrations' }
    : undefined;
}

export function selectD1Migrations(
  project: Pick<Project, 'dirPath' | 'packageJson'>,
  d1Databases: CloudflareD1Database[],
  drizzleKitManagesD1: boolean
): D1Migrations {
  const cfNativeSettings = d1Databases.length > 0 ? findCfNativeD1MigrationSettings(project) : undefined;
  if (cfNativeSettings) {
    return { cfNativeD1Databases: d1Databases, cfNativeSettings, unmanagedD1Databases: [] };
  }
  if (!drizzleKitManagesD1) {
    return { cfNativeD1Databases: [], unmanagedD1Databases: d1Databases };
  }
  if (d1Databases.length > 1) {
    return {
      cfNativeD1Databases: [],
      errorMessage: 'wb supports drizzle-kit migrations only for a single D1 binding; found multiple.',
      unmanagedD1Databases: [],
    };
  }
  return { cfNativeD1Databases: [], drizzleD1Database: d1Databases[0], unmanagedD1Databases: [] };
}

export function formatD1DatabaseNames(d1Databases: CloudflareD1Database[]): string {
  return d1Databases.map((database) => database.binding).join(', ');
}
