import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { readEnvironmentVariables } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import { config } from 'dotenv';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject } from '../project.js';
import { buildDrizzleKitCommand } from '../scripts/drizzleScripts.js';
import { runWithSpawn } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { isCI } from '../utils/ci.js';
import { buildShellEnvironmentAssignment, shellEscapeArgument } from '../utils/shell.js';
import { findWranglerConfigPath } from '../utils/wrangler.js';
import type { ResolvedWranglerConfig, WranglerD1Database } from '../utils/wranglerConfig.js';
import { resolveWranglerConfigForEnv, usesWranglerNativeMigrations } from '../utils/wranglerConfig.js';

import { readEnvExampleKeys } from './genDevVars.js';

/**
 * Keys that drive the deploy itself (or are meaningful only locally) and thus must never be
 * pushed to the Worker as secrets. `WB_ENV` / `NEXT_PUBLIC_WB_ENV` belong in wrangler `vars`.
 */
const NON_SECRET_KEYS = new Set([
  'CI',
  // Wrangler system/authentication variables (https://developers.cloudflare.com/workers/wrangler/system-environment-variables/),
  // including legacy aliases; app-specific names such as CLOUDFLARE_R2_ACCESS_KEY_ID stay eligible.
  'CF_ACCOUNT_ID',
  'CF_API_BASE_URL',
  'CF_API_EMAIL',
  'CF_API_KEY',
  'CF_API_TOKEN',
  'CF_EMAIL',
  'CLOUDFLARE_ACCESS_CLIENT_ID',
  'CLOUDFLARE_ACCESS_CLIENT_SECRET',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_BASE_URL',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_AUTH_USE_KEYRING',
  'CLOUDFLARE_D1_DATABASE_ID',
  'CLOUDFLARE_EMAIL',
  'CLOUDFLARE_ENV',
  'DOCKER_HOST',
  'FORCE_COLOR',
  'MINIFLARE_CACHE_DIR',
  'MISE_ENV',
  'NO_COLOR',
  'NEXT_PUBLIC_WB_ENV',
  'NEXT_PUBLIC_WB_VERSION',
  'NODE_ENV',
  'PORT',
  'WB_ENV',
  'WB_VERSION',
]);

const NON_SECRET_KEY_PREFIXES = ['WRANGLER_', 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_', 'CLOUDFLARE_CF_FETCH_'];

function isNonSecretKey(key: string): boolean {
  return NON_SECRET_KEYS.has(key) || NON_SECRET_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

const builder = {} as const;

type DeployCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type DeployCommandArgv = ArgumentsCamelCase<DeployCommandOptions>;

export const deployCommand: CommandModule<unknown, DeployCommandOptions> = {
  command: 'deploy',
  describe:
    'Deploy a Cloudflare Workers app (vinext or plain Worker) to the WB_ENV environment: validate secrets, build, apply remote D1 migrations, then deploy code and secrets atomically.',
  builder: (yargs) => yargs as unknown as Argv<DeployCommandOptions>,
  async handler(argv: DeployCommandArgv) {
    // A stray exported CLOUDFLARE_ENV would bake the wrong environment into the build and
    // apply the environment suffix twice on deploy; it is re-set explicitly where needed.
    delete process.env.CLOUDFLARE_ENV;

    const project = findSelfProject(argv);
    if (!project) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }
    const wranglerConfigPath = findWranglerConfigPath(project);
    if (!wranglerConfigPath) {
      console.error(chalk.red('wb deploy currently supports only Cloudflare Workers apps (no wrangler config found).'));
      process.exit(1);
    }
    // project.env is memoized (a single object per Project instance), so in-place
    // mutations like the following persist for every later read and spawned command.
    delete project.env.CLOUDFLARE_ENV;

    const envName = project.env.WB_ENV;
    if (!envName || envName === 'development' || envName === 'test') {
      console.error(
        chalk.red(`WB_ENV must name a deploy environment (e.g. staging or production), but is ${envName}.`)
      );
      process.exit(1);
    }

    // CI provides the Cloudflare API token via a .env.cloudflare file (e.g. the reusable deploy
    // workflow's FILE_CONTENT_1); already-exported environment variables win over its values.
    const cloudflareEnvPath = path.join(project.dirPath, '.env.cloudflare');
    if (fs.existsSync(cloudflareEnvPath)) {
      const parsed = config({ path: cloudflareEnvPath, processEnv: {}, quiet: true }).parsed ?? {};
      for (const [key, value] of Object.entries(parsed)) {
        if (key === 'CLOUDFLARE_ENV') continue;
        // ??= so that an explicitly exported empty value still wins over the file.
        project.env[key] ??= value;
      }
    }

    let resolvedConfig: ResolvedWranglerConfig | undefined;
    try {
      resolvedConfig = resolveWranglerConfigForEnv(project, envName);
    } catch (error) {
      console.error(chalk.red(String(error instanceof Error ? error.message : error)));
      process.exit(1);
    }
    if (!resolvedConfig) {
      console.error(chalk.red(`Failed to parse ${wranglerConfigPath}.`));
      process.exit(1);
    }
    const accountId = resolvedConfig.accountId ?? project.env.CLOUDFLARE_ACCOUNT_ID;
    // Prefer wrangler-native migrations whenever the resolved environment's D1 bindings have an
    // existing migrations directory: a drizzle-orm dependency alone does not imply the project
    // migrates D1 with drizzle-kit's d1-http driver (some drizzle apps use wrangler-native).
    const wranglerNativeD1Databases = resolvedConfig.d1Databases.filter((database) =>
      usesWranglerNativeMigrations(project, database)
    );
    if (
      project.hasDrizzle &&
      wranglerNativeD1Databases.length > 0 &&
      wranglerNativeD1Databases.length < resolvedConfig.d1Databases.length
    ) {
      // Migrating only the wrangler-native subset would silently deploy code against the
      // other, unmigrated databases.
      console.error(
        chalk.red('wb deploy does not support mixing wrangler-native and non-native D1 migration layouts.')
      );
      process.exit(1);
    }
    const drizzleD1Database =
      wranglerNativeD1Databases.length === 0 && project.hasDrizzle ? resolvedConfig.d1Databases[0] : undefined;
    if (wranglerNativeD1Databases.length === 0 && project.hasDrizzle && resolvedConfig.d1Databases.length > 1) {
      console.error(
        chalk.red('wb deploy supports drizzle-kit migrations only for a single D1 binding; found multiple.')
      );
      process.exit(1);
    }
    if (!project.env.CLOUDFLARE_API_TOKEN && (isCI(project.env.CI) || drizzleD1Database)) {
      // drizzle-kit's d1-http driver requires an API token even for local runs; a local
      // wrangler OAuth login covers only the wrangler-native path.
      console.error(chalk.red('CLOUDFLARE_API_TOKEN is required to deploy.'));
      process.exit(1);
    }

    // App-specific validation hook (e.g. secret pairs that must be both-set-or-both-empty).
    // The reusable deploy.yml already runs it on CI; run it here for local deploys.
    if (!isCI(project.env.CI) && project.packageJson.scripts?.['deploy/ci-setup']) {
      await runWithSpawn('YARN run deploy/ci-setup', project, argv);
    }

    // 1. Resolve and validate all secrets before any build or remote mutation, so a missing
    //    secret aborts the deploy instead of leaving a migrated database behind an old Worker.
    const [envVars, envSources] = readEnvironmentVariables(argv, project.dirPath, { ignoreProcessEnv: true });
    // Restrict the secrets domain to keys defined in the project's .env files: `mise env`
    // output (reported as a pseudo-source) mixes in host/tool variables such as CARGO_HOME,
    // which must never be uploaded as Worker secrets.
    const dotenvKeys = new Set(
      envSources.filter(([source]) => !source.startsWith('mise env')).flatMap(([, keys]) => keys)
    );
    for (const key of Object.keys(envVars)) {
      if (!dotenvKeys.has(key)) delete envVars[key];
    }
    // Wrangler validates `secrets.required` only during the real upload — after migrations —
    // so wb requires those keys upfront too (the wb flow keeps all secrets in dotenv values).
    const requiredKeys = [...new Set([...readEnvExampleKeys(project), ...resolvedConfig.requiredSecretNames])];
    for (const key of requiredKeys) {
      envVars[key] ??= project.env[key] ?? '';
    }
    // Explicitly exported environment variables must win over dotenv values (project.env already
    // applies that precedence), or `AUTH_SECRET=... wb deploy` would push the stale file value.
    for (const key of Object.keys(envVars)) {
      const effectiveValue = project.env[key];
      if (effectiveValue !== undefined) envVars[key] = effectiveValue;
    }
    const { missingKeys, secrets } = selectWorkerSecrets(
      envVars,
      [...resolvedConfig.varKeys, ...resolvedConfig.bindingNames],
      requiredKeys
    );
    const bindingCollisions = Object.keys(envVars).filter((key) => resolvedConfig.bindingNames.includes(key));
    if (bindingCollisions.length > 0) {
      // Uploading a secret named like a binding would replace the binding with a plain string.
      console.warn(
        chalk.yellow(`Skipping env keys that collide with Worker binding names: ${bindingCollisions.join(', ')}`)
      );
    }
    if (missingKeys.length > 0) {
      console.error(
        chalk.red(
          `Missing required environment variables (from .env.example or wrangler secrets.required): ${missingKeys.join(', ')}`
        )
      );
      process.exit(1);
    }
    const secretKeys = Object.keys(secrets).toSorted();
    // Cloudflare limits a bulk upload to 100 secrets, each variable/secret value to 5 KB, and
    // the combined variable+secret count to 128 (64 on the Free plan, which cannot be detected
    // here — hence a warning). Failing before any build or migration keeps an oversized payload
    // from aborting the deploy after remote migrations already ran.
    if (secretKeys.length > 100) {
      console.error(
        chalk.red(`Cloudflare accepts at most 100 secrets per deploy, but ${secretKeys.length} were selected.`)
      );
      process.exit(1);
    }
    // The CLI-provided WB_VERSION overlays a configured var of the same name on deploy,
    // so only the effective value participates in the limit checks.
    const effectiveVars = new Map(Object.entries<unknown>(resolvedConfig.vars));
    if (project.env.WB_VERSION) effectiveVars.set('WB_VERSION', project.env.WB_VERSION);
    const varEntries = [...effectiveVars];
    const combinedCount = new Set([...secretKeys, ...varEntries.map(([key]) => key)]).size;
    if (combinedCount > 128) {
      console.error(
        chalk.red(`Cloudflare allows at most 128 variables and secrets combined, but ${combinedCount} were selected.`)
      );
      process.exit(1);
    }
    if (combinedCount > 64) {
      console.warn(chalk.yellow(`${combinedCount} variables and secrets exceed the Free plan's limit of 64.`));
    }
    const oversizedKeys = [
      ...secretKeys.filter((key) => Buffer.byteLength(secrets[key] ?? '', 'utf8') > 5 * 1024),
      ...varEntries
        .filter(
          ([, value]) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') > 5 * 1024
        )
        .map(([key]) => key),
    ];
    if (oversizedKeys.length > 0) {
      console.error(chalk.red(`Variable or secret values exceed Cloudflare's 5 KB limit: ${oversizedKeys.join(', ')}`));
      process.exit(1);
    }
    console.info(
      chalk.cyan(
        `Deploying ${resolvedConfig.workerName ?? project.name} (${envName}) with ${secretKeys.length} secrets: ${secretKeys.join(', ')}`
      )
    );

    // 2. Build (vinext embeds the environment-applied wrangler config into dist/server/wrangler.json).
    //    Building before migrating keeps a build failure from leaving a migrated schema behind
    //    the old Worker. Plain Workers have no build step; wrangler bundles the entry itself.
    const isVinext = !!(project.packageJson.dependencies?.vinext ?? project.packageJson.devDependencies?.vinext);
    const cloudflareEnvAssignment = resolvedConfig.usesEnvSection
      ? `${buildShellEnvironmentAssignment('CLOUDFLARE_ENV', envName)} `
      : '';
    if (isVinext) {
      if (project.env.WB_VERSION) {
        project.env.NEXT_PUBLIC_WB_VERSION ||= project.env.WB_VERSION;
      }
      if (project.packageJson.scripts?.['gen-code']) {
        await runWithSpawn('YARN run gen-code', project, argv);
      }
      await runWithSpawn(`${cloudflareEnvAssignment}YARN vinext build`, project, argv);
    } else {
      // Plain Workers are first compiled by wrangler during the deploy itself; a dry run
      // surfaces compile errors (e.g. a missing entry point) BEFORE the remote migrations
      // below mutate the database.
      await runWithSpawn(
        `YARN wrangler deploy --dry-run --config ${shellEscapeArgument(wranglerConfigPath)}${resolvedConfig.usesEnvSection ? ` --env ${shellEscapeArgument(envName)}` : ''}`,
        project,
        argv
      );
    }

    // 3. Apply D1 migrations to the remote database with the project's single migration
    //    mechanism (wrangler-native when a migrations directory exists, else drizzle-kit for
    //    drizzle-orm apps). Migrations must be backward compatible: the old Worker serves
    //    traffic until the deploy below.
    const envOption = resolvedConfig.usesEnvSection ? ` --env ${shellEscapeArgument(envName)}` : '';
    for (const database of wranglerNativeD1Databases) {
      const databaseName = database.database_name ?? database.binding;
      if (!databaseName) continue;
      await runWithSpawn(
        `CI=true YARN wrangler d1 migrations apply ${shellEscapeArgument(databaseName)} --remote --config ${shellEscapeArgument(wranglerConfigPath)}${envOption}`,
        project,
        argv
      );
    }
    if (drizzleD1Database) {
      if (!drizzleD1Database.database_id) {
        console.error(chalk.red(`The ${envName} D1 binding has no database_id in the wrangler config.`));
        process.exit(1);
      }
      if (!accountId) {
        console.error(
          chalk.red(
            'CLOUDFLARE_ACCOUNT_ID (or account_id in the wrangler config) is required for remote drizzle-kit migrations.'
          )
        );
        process.exit(1);
      }
      await runWithSpawn(
        buildDrizzleKitCommand(
          project,
          'migrate',
          `CLOUDFLARE_D1_DATABASE_ID=${drizzleD1Database.database_id} CLOUDFLARE_ACCOUNT_ID=${accountId}`
        ),
        project,
        argv
      );
    }

    // 4. Deploy code and secrets atomically: piping the secrets JSON via stdin avoids both a
    //    plaintext temp file and a post-deploy secret push that could leave the new version
    //    running without (or with stale) secrets. Explicitly empty values stay in the payload:
    //    --secrets-file is additive, so pushing '' is the only way to clear a stale secret.
    const deployConfigPath = isVinext ? path.join('dist', 'server', 'wrangler.json') : wranglerConfigPath;
    if (isVinext && !argv.dryRun && !fs.existsSync(path.resolve(project.dirPath, deployConfigPath))) {
      console.error(chalk.red(`${deployConfigPath} not found; the vinext build did not produce a deploy config.`));
      process.exit(1);
    }
    const deployArgs = [
      'deploy',
      '--config',
      deployConfigPath,
      // vinext's built config already has the environment applied; passing --env there would
      // apply the environment suffix twice.
      ...(!isVinext && resolvedConfig.usesEnvSection ? ['--env', envName] : []),
      ...(project.env.WB_VERSION ? ['--var', `WB_VERSION:${project.env.WB_VERSION}`] : []),
      '--secrets-file',
      '/dev/stdin',
    ];
    console.info(chalk.cyan(`Running: wrangler ${deployArgs.join(' ')}`));
    if (!argv.dryRun) {
      // Reading binExists prepends node_modules/.bin directories to project.env.PATH,
      // so the direct (non-shell) wrangler spawn below resolves the local binary.
      if (!project.binExists) {
        console.warn(chalk.yellow('node_modules/.bin not found; relying on PATH to resolve wrangler.'));
      }
      const deployEnv = { ...project.env };
      delete deployEnv.CLOUDFLARE_ENV;
      const result = spawnSync('wrangler', deployArgs, {
        cwd: project.dirPath,
        env: deployEnv as NodeJS.ProcessEnv,
        input: JSON.stringify(secrets),
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      if (result.status !== 0) {
        console.error(chalk.red(`wrangler deploy failed with exit code ${result.status ?? 'unknown'}.`));
        process.exit(result.status ?? 1);
      }
    }

    // 5. Optional post-deploy hook (e.g. seeding the remote D1 via drizzle's d1-http driver).
    //    Assign the resolved ids unconditionally: a stale exported CLOUDFLARE_D1_DATABASE_ID
    //    must not redirect the hook to another database.
    if (project.packageJson.scripts?.['deploy/post']) {
      // The id is unambiguous only with a single D1 binding; with multiple, the hook must
      // resolve its target itself. Clear first either way: a stale inherited id must not
      // redirect the hook to another database.
      const hookD1Database: WranglerD1Database | undefined =
        resolvedConfig.d1Databases.length === 1 ? resolvedConfig.d1Databases[0] : undefined;
      delete project.env.CLOUDFLARE_D1_DATABASE_ID;
      if (resolvedConfig.d1Databases.length > 1) {
        console.warn(chalk.yellow('Multiple D1 bindings exist; CLOUDFLARE_D1_DATABASE_ID is not set for deploy/post.'));
      }
      if (hookD1Database?.database_id) project.env.CLOUDFLARE_D1_DATABASE_ID = hookD1Database.database_id;
      if (accountId) project.env.CLOUDFLARE_ACCOUNT_ID = accountId;
      await runWithSpawn('YARN run deploy/post', project, argv);
    }
  },
};

/**
 * Select the secrets to push to the Worker from the dotenv-loaded environment variables:
 * every explicitly set value — including empty strings, which clear stale remote secrets
 * since `wrangler deploy --secrets-file` is additive — except wrangler `vars` (a secret may
 * not share a name with a var), deploy-control keys, and local `file:` DATABASE_URLs.
 * Returns the required keys (from .env.example) that are still empty so the deploy can
 * abort before any remote mutation.
 */
export function selectWorkerSecrets(
  envVars: Record<string, string>,
  configVarKeys: string[],
  requiredKeys: string[]
): { missingKeys: string[]; secrets: Record<string, string> } {
  const configKeys = new Set(configVarKeys);
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (value === undefined || configKeys.has(key) || isNonSecretKey(key)) continue;
    if (key === 'DATABASE_URL' && value.startsWith('file:')) continue;
    secrets[key] = value;
  }
  const missingKeys = requiredKeys.filter((key) => !configKeys.has(key) && !isNonSecretKey(key) && !envVars[key]);
  return { missingKeys, secrets };
}
