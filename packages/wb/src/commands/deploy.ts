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
import { findWranglerConfigPath } from '../utils/wrangler.js';
import type { ResolvedWranglerConfig, WranglerD1Database } from '../utils/wranglerConfig.js';
import { resolveWranglerConfigForEnv } from '../utils/wranglerConfig.js';

import { readEnvExampleKeys } from './genDevVars.js';

/**
 * Keys that drive the deploy itself (or are meaningful only locally) and thus must never be
 * pushed to the Worker as secrets. `WB_ENV` / `NEXT_PUBLIC_WB_ENV` belong in wrangler `vars`.
 */
const NON_SECRET_KEYS = new Set([
  'CI',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_D1_DATABASE_ID',
  'CLOUDFLARE_ENV',
  'NEXT_PUBLIC_WB_ENV',
  'NEXT_PUBLIC_WB_VERSION',
  'NODE_ENV',
  'PORT',
  'WB_ENV',
  'WB_VERSION',
]);

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
        project.env[key] ||= value;
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
      fs.existsSync(path.resolve(project.dirPath, database.migrations_dir ?? 'migrations'))
    );
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
    const [envVars] = readEnvironmentVariables(argv, project.dirPath, { ignoreProcessEnv: true });
    const requiredKeys = readEnvExampleKeys(project);
    for (const key of requiredKeys) {
      envVars[key] ??= project.env[key] ?? '';
    }
    // Explicitly exported environment variables must win over dotenv values (project.env already
    // applies that precedence), or `AUTH_SECRET=... wb deploy` would push the stale file value.
    for (const key of Object.keys(envVars)) {
      const effectiveValue = project.env[key];
      if (effectiveValue !== undefined) envVars[key] = effectiveValue;
    }
    const { missingKeys, secrets } = selectWorkerSecrets(envVars, resolvedConfig.varKeys, requiredKeys);
    if (missingKeys.length > 0) {
      console.error(chalk.red(`Missing required environment variables (from .env.example): ${missingKeys.join(', ')}`));
      process.exit(1);
    }
    const secretKeys = Object.keys(secrets).toSorted();
    console.info(
      chalk.cyan(
        `Deploying ${resolvedConfig.workerName ?? project.name} (${envName}) with ${secretKeys.length} secrets: ${secretKeys.join(', ')}`
      )
    );

    // 2. Build (vinext embeds the environment-applied wrangler config into dist/server/wrangler.json).
    //    Building before migrating keeps a build failure from leaving a migrated schema behind
    //    the old Worker. Plain Workers have no build step; wrangler bundles the entry itself.
    const isVinext = !!(project.packageJson.dependencies?.vinext ?? project.packageJson.devDependencies?.vinext);
    const cloudflareEnvAssignment = resolvedConfig.usesEnvSection ? `CLOUDFLARE_ENV=${envName} ` : '';
    if (isVinext) {
      if (project.env.WB_VERSION) {
        project.env.NEXT_PUBLIC_WB_VERSION ||= project.env.WB_VERSION;
      }
      if (project.packageJson.scripts?.['gen-code']) {
        await runWithSpawn('YARN run gen-code', project, argv);
      }
      await runWithSpawn(`${cloudflareEnvAssignment}YARN vinext build`, project, argv);
    }

    // 3. Apply D1 migrations to the remote database with the project's single migration
    //    mechanism (wrangler-native when a migrations directory exists, else drizzle-kit for
    //    drizzle-orm apps). Migrations must be backward compatible: the old Worker serves
    //    traffic until the deploy below.
    const envOption = resolvedConfig.usesEnvSection ? ` --env ${envName}` : '';
    for (const database of wranglerNativeD1Databases) {
      const databaseName = database.database_name ?? database.binding;
      if (!databaseName) continue;
      await runWithSpawn(
        `CI=true YARN wrangler d1 migrations apply ${databaseName} --remote --config "${wranglerConfigPath}"${envOption}`,
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
    if (argv.dryRun) return;

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

    // 5. Optional post-deploy hook (e.g. seeding the remote D1 via drizzle's d1-http driver).
    //    Assign the resolved ids unconditionally: a stale exported CLOUDFLARE_D1_DATABASE_ID
    //    must not redirect the hook to another database.
    if (project.packageJson.scripts?.['deploy/post']) {
      const hookD1Database: WranglerD1Database | undefined = drizzleD1Database ?? resolvedConfig.d1Databases[0];
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
  const excludedKeys = new Set([...NON_SECRET_KEYS, ...configVarKeys]);
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (value === undefined || excludedKeys.has(key)) continue;
    if (key === 'DATABASE_URL' && value.startsWith('file:')) continue;
    secrets[key] = value;
  }
  const missingKeys = requiredKeys.filter((key) => !excludedKeys.has(key) && !envVars[key]);
  return { missingKeys, secrets };
}
