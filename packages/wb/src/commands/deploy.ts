import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readEnvironmentVariables, spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import { config } from 'dotenv';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
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
  'CLOUDFLARE_INCLUDE_PROCESS_ENV',
  'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV',
  'DOCKER_HOST',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
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
    // A dotenv file defining it still surfaces through project.env, which the explicit `--env`
    // flags below override.
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
    const envName = project.env.WB_ENV;
    if (!envName || envName === 'development' || envName === 'test') {
      console.error(
        chalk.red(`WB_ENV must name a deploy environment (e.g. staging or production), but is ${envName}.`)
      );
      process.exit(1);
    }

    // The values go into both process.env (inherited by everything wb spawns) and project.env
    // (the environment wb itself reads and passes explicitly); the latter is a cached snapshot
    // taken before this point, so writing only to process.env would leave wb's own preflight —
    // and any command spawned with project.env — without the token.
    // Only --include-root-env gates the root lookup, not an explicit --env: --env replaces the
    // dotenv VARIABLE sources, while .env.cloudflare is a credential sidecar read outside that
    // cascade (the project's own copy is read regardless of --env, as it always has been).
    // Gating on --env would make `wb deploy --env <file>` silently stop finding the repo's token.
    const cloudflareEnvVars = readCloudflareEnvFiles(
      project.dirPath,
      argv.includeRootEnv ? project.rootDirPath : undefined
    );
    for (const [key, value] of Object.entries(cloudflareEnvVars)) {
      // ??= so that an explicitly exported empty value still wins over the file.
      process.env[key] ??= value;
      project.env[key] ??= value;
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
    // Dry runs execute nothing authenticated, so they skip the credential preflight entirely.
    if (!argv.dryRun) {
      if (drizzleD1Database && !project.env.CLOUDFLARE_API_TOKEN) {
        // drizzle-kit's d1-http driver requires this specific token even for local runs; a
        // local wrangler OAuth login covers only the wrangler-native path.
        console.error(chalk.red('CLOUDFLARE_API_TOKEN is required for remote drizzle-kit migrations.'));
        process.exit(1);
      }
      const hasWranglerAuthentication =
        !!project.env.CLOUDFLARE_API_TOKEN ||
        !!project.env.CF_API_TOKEN ||
        !!(project.env.CLOUDFLARE_API_KEY && project.env.CLOUDFLARE_EMAIL) ||
        !!(project.env.CF_API_KEY && project.env.CF_EMAIL);
      if (isCI(project.env.CI) && !hasWranglerAuthentication) {
        console.error(chalk.red('Wrangler authentication (e.g. CLOUDFLARE_API_TOKEN) is required to deploy on CI.'));
        process.exit(1);
      }
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
    const requiredKeys = readEnvExampleKeys(project);
    for (const key of requiredKeys) {
      envVars[key] ??= project.env[key] ?? '';
    }
    // Names declared via wrangler `secrets.required` may likewise be supplied purely as
    // exported environment variables (e.g. CI workflow env) instead of dotenv values.
    for (const key of resolvedConfig.requiredSecretNames) {
      const exportedValue = project.env[key];
      if (envVars[key] === undefined && exportedValue !== undefined) envVars[key] = exportedValue;
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
    // `--var WB_VERSION:...` takes precedence over configuration values on deploy, so a
    // resource binding of that name would silently become a string variable.
    if (project.env.WB_VERSION && resolvedConfig.bindingNames.includes('WB_VERSION')) {
      console.error(chalk.red('WB_VERSION collides with a Worker binding name; rename the binding.'));
      process.exit(1);
    }
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
    // Wrangler validates `secrets.required` only during the real upload — after migrations —
    // so wb checks upfront: each required name must be a key in the outgoing payload (presence,
    // not truthiness — an explicit empty clears a stale value) or an effective var/binding.
    const unsatisfiedRequiredSecretNames = resolvedConfig.requiredSecretNames.filter(
      (name) =>
        !Object.hasOwn(secrets, name) &&
        !resolvedConfig.varKeys.includes(name) &&
        !resolvedConfig.bindingNames.includes(name)
    );
    if (unsatisfiedRequiredSecretNames.length > 0) {
      console.error(
        chalk.red(
          `Secrets required by the wrangler config are not provided: ${unsatisfiedRequiredSecretNames.join(', ')}`
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
    // `--secrets-file` is additive: remote secrets absent from the payload stay attached to the
    // new version, so they count against the combined limit too. Listing them needs an
    // authenticated remote round-trip, which dry runs skip; when the listing fails for any
    // reason other than a not-yet-created Worker, degrade to the local-only count instead of
    // blocking a deploy that wrangler itself might accept.
    const remoteSecretNames = argv.dryRun
      ? []
      : await listRemoteWorkerSecretNames(project, argv, wranglerConfigPath, resolvedConfig, envName);
    const inheritedSecretNames = selectInheritedRemoteSecretNames(
      remoteSecretNames ?? [],
      secrets,
      varEntries.map(([key]) => key),
      resolvedConfig.bindingNames
    );
    const combinedCount =
      new Set([...secretKeys, ...varEntries.map(([key]) => key)]).size + inheritedSecretNames.length;
    const inheritedNote =
      inheritedSecretNames.length > 0
        ? ` (including ${inheritedSecretNames.length} remote secrets kept from the previous version: ${inheritedSecretNames.join(', ')})`
        : '';
    if (combinedCount > 128) {
      console.error(
        chalk.red(
          `Cloudflare allows at most 128 variables and secrets combined, but ${combinedCount} were selected${inheritedNote}.`
        )
      );
      process.exit(1);
    }
    if (combinedCount > 64) {
      console.warn(
        chalk.yellow(`${combinedCount} variables and secrets${inheritedNote} exceed the Free plan's limit of 64.`)
      );
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
    const deployConfigPath = isVinext ? path.join('dist', 'server', 'wrangler.json') : wranglerConfigPath;
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
      // On dry runs the vinext build above is a printed no-op, so the built config is
      // legitimately absent and must not abort the run.
      if (!argv.dryRun && !fs.existsSync(path.resolve(project.dirPath, deployConfigPath))) {
        console.error(chalk.red(`${deployConfigPath} not found; the vinext build did not produce a deploy config.`));
        process.exit(1);
      }
      // Wrangler validates its config schema only when it runs, so a dry run of the built
      // config surfaces config and bundle errors BEFORE the remote migrations below mutate
      // the database, mirroring the plain-Worker dry run. No --env: the built config already
      // has the environment applied.
      await runWithSpawn(
        `YARN wrangler deploy --dry-run --config ${shellEscapeArgument(deployConfigPath)}`,
        project,
        argv
      );
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

    // 4. Deploy code and secrets atomically (no post-deploy secret push that could leave the
    //    new version running without — or with stale — secrets). The secrets JSON goes through
    //    a mode-0600 file in a private temporary directory deleted right after the deploy:
    //    /dev/stdin is NOT reliable here because wrangler reads the secrets file only after
    //    uploading assets, by which point the piped stdin may already have been consumed —
    //    observed as a flaky `Could not read file: /dev/stdin` on CI. Explicitly empty values
    //    stay in the payload: --secrets-file is additive, so pushing '' is the only way to
    //    clear a stale secret.
    const deployArgs = [
      'deploy',
      '--config',
      deployConfigPath,
      // vinext's built config already has the environment applied; passing --env there would
      // apply the environment suffix twice.
      ...(!isVinext && resolvedConfig.usesEnvSection ? ['--env', envName] : []),
      ...(project.env.WB_VERSION ? ['--var', `WB_VERSION:${project.env.WB_VERSION}`] : []),
      '--secrets-file',
    ];
    console.info(chalk.cyan(`Running: wrangler ${deployArgs.join(' ')} <temporary secrets file>`));
    if (!argv.dryRun) {
      prepareLocalBinPath(project);
      const deployEnv = { ...project.env };
      delete deployEnv.CLOUDFLARE_ENV;
      // 0o700 directory + 0o600 file: readable only by the deploying user, like the dotenv
      // files the CI workflow already writes next to it. wrangler runs through an async spawn
      // (spawnSync would block the event loop, so a shutdown signal would kill the process
      // before any cleanup) and the directory is removed in a finally, so an interrupted
      // deploy cannot leave the plaintext secrets behind. Shutdown handling details:
      // - Handlers (including SIGHUP, on which Node also terminates by default) are installed
      //   BEFORE the file is written and use process.on, not once, so a repeated signal cannot
      //   fall back to default termination and bypass the finally cleanup.
      // - SIGHUP/SIGQUIT are forwarded to wrangler as SIGTERM: wrangler's launcher relays only
      //   SIGINT/SIGTERM to its inner Node process, and anything else would orphan a deployment
      //   that keeps mutating the remote Worker after wb exits.
      // - The re-raise below uses the signal wb itself received: wrangler catches SIGINT and
      //   exits numerically (e.g. 143), which must not masquerade as an ordinary failure.
      const secretsDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-deploy-'));
      const shutdownSignals = ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGQUIT'] as const;
      const signalHandlers = new Map<NodeJS.Signals, () => void>();
      let wranglerProcess: ReturnType<typeof spawn> | undefined;
      let receivedShutdownSignal: NodeJS.Signals | undefined;
      for (const signal of shutdownSignals) {
        const signalHandler = (): void => {
          receivedShutdownSignal ??= signal;
          if (wranglerProcess) {
            wranglerProcess.kill(signal === 'SIGINT' || signal === 'SIGTERM' ? signal : 'SIGTERM');
          } else {
            for (const [shutdownSignal, handler] of signalHandlers) {
              process.off(shutdownSignal, handler);
            }
            fs.rmSync(secretsDirPath, { force: true, recursive: true });
            // With the handlers removed, re-raising triggers the default behavior.
            process.kill(process.pid, signal);
          }
        };
        signalHandlers.set(signal, signalHandler);
        process.on(signal, signalHandler);
      }
      let deployStatus: number | undefined;
      try {
        const secretsFilePath = path.join(secretsDirPath, 'secrets.json');
        fs.writeFileSync(secretsFilePath, JSON.stringify(secrets), { mode: 0o600 });
        deployStatus = await new Promise<number | undefined>((resolve) => {
          wranglerProcess = spawn('wrangler', [...deployArgs, secretsFilePath], {
            cwd: project.dirPath,
            env: deployEnv as NodeJS.ProcessEnv,
            stdio: ['ignore', 'inherit', 'inherit'],
          });
          wranglerProcess.on('error', (error) => {
            console.error(error);
            resolve(1);
          });
          wranglerProcess.on('exit', (code, signal) => {
            resolve(signal ? 1 : (code ?? undefined));
          });
        });
      } finally {
        // process.exit skips finally blocks, so the exit-on-failure below stays outside.
        for (const [shutdownSignal, signalHandler] of signalHandlers) {
          process.off(shutdownSignal, signalHandler);
        }
        fs.rmSync(secretsDirPath, { force: true, recursive: true });
      }
      if (receivedShutdownSignal) {
        // Re-raise so the caller observes the same signal-derived exit status.
        process.kill(process.pid, receivedShutdownSignal);
        return;
      }
      if (deployStatus !== 0) {
        console.error(chalk.red(`wrangler deploy failed with exit code ${deployStatus ?? 'unknown'}.`));
        process.exit(deployStatus ?? 1);
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
 * Read the Cloudflare API token that CI drops in a `.env.cloudflare` file (e.g. the reusable
 * deploy workflow's `file_path_1`), looking beside the Worker's wrangler config and at the
 * monorepo root — `file_path_1` is repo-relative, so both spellings occur in practice.
 * Nearer files win, mirroring the `.env` cascade: a workspace may override the root token,
 * never the reverse. Pass `rootDirPath` as undefined to read the workspace alone, so that
 * `--include-root-env=false` isolates this file from the root just as it does the cascade.
 * `CLOUDFLARE_ENV` is dropped; it would double-apply the environment suffix.
 */
export function readCloudflareEnvFiles(dirPath: string, rootDirPath: string | undefined): Record<string, string> {
  const envVars: Record<string, string> = {};
  for (const currentDirPath of new Set(rootDirPath ? [dirPath, rootDirPath] : [dirPath])) {
    const cloudflareEnvPath = path.join(currentDirPath, '.env.cloudflare');
    if (!fs.existsSync(cloudflareEnvPath)) continue;
    const parsed = config({ path: cloudflareEnvPath, processEnv: {}, quiet: true }).parsed ?? {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key === 'CLOUDFLARE_ENV') continue;
      envVars[key] ??= value;
    }
  }
  return envVars;
}

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
  // No runtime undefined check on `value`: envVars is built exclusively from dotenv-parsed
  // strings, and every caller-side merge either coalesces with `?? ''` or guards against
  // undefined before assigning, so the Record<string, string> type holds at runtime too.
  for (const [key, value] of Object.entries(envVars)) {
    if (configKeys.has(key) || isNonSecretKey(key)) continue;
    if (key === 'DATABASE_URL' && value.startsWith('file:')) continue;
    secrets[key] = value;
  }
  const missingKeys = requiredKeys.filter((key) => !configKeys.has(key) && !isNonSecretKey(key) && !envVars[key]);
  return { missingKeys, secrets };
}

/**
 * List the secret names currently attached to the deploy target Worker. Returns undefined when
 * the listing fails for any reason other than the Worker not existing yet (first deploy), so
 * the caller can degrade to the local-only limit checks instead of blocking a deploy that
 * wrangler itself might accept. Failing closed instead would turn every transient listing
 * failure (network, a token without secret-read permission) into a deploy blocker, and — since
 * wrangler 4.x reports a missing Worker only via an error-message hint — any unrecognized
 * not-found shape would then block first deploys entirely; this preflight must only ever add
 * failures that wrangler itself would raise after the migrations.
 */
async function listRemoteWorkerSecretNames(
  project: Project,
  argv: DeployCommandArgv,
  wranglerConfigPath: string,
  resolvedConfig: ResolvedWranglerConfig,
  envName: string
): Promise<string[] | undefined> {
  prepareLocalBinPath(project);
  const listArgs = [
    'secret',
    'list',
    '--format',
    'json',
    '--config',
    wranglerConfigPath,
    ...(resolvedConfig.usesEnvSection ? ['--env', envName] : []),
  ];
  console.info(chalk.cyan(`Running: wrangler ${listArgs.join(' ')}`));
  let ret;
  try {
    ret = await spawnAsync('wrangler', listArgs, {
      cwd: project.dirPath,
      env: project.env as NodeJS.ProcessEnv,
      stdio: 'pipe',
      killOnExit: true,
      verbose: argv.verbose,
    });
  } catch (error) {
    console.warn(
      chalk.yellow(
        `Failed to run wrangler to list remote secrets; checking only the local payload against Cloudflare's limits.\n${error instanceof Error ? error.message : String(error)}`
      )
    );
    return undefined;
  }
  if (ret.status === 0) {
    // Cut the JSON array out of the surrounding output: wrangler may print its banner and
    // "Multiple environments" warnings around the payload.
    const jsonStart = ret.stdout.indexOf('[');
    const jsonEnd = ret.stdout.lastIndexOf(']');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonStart < jsonEnd) {
      try {
        const parsed = JSON.parse(ret.stdout.slice(jsonStart, jsonEnd + 1)) as { name?: unknown }[];
        return parsed.map(({ name }) => name).filter((name): name is string => typeof name === 'string');
      } catch {
        // Fall through to the warning below.
      }
    }
  } else if (/\[code: 100(07|90)\]|If this is a new Worker/.test(ret.stdout + ret.stderr)) {
    // The Worker does not exist yet, so a first deploy inherits nothing. Wrangler 4.x catches
    // the Cloudflare API errors 10007 (workers.api.error.service_not_found) and 10090
    // (workers.api.error.script_not_found) and rethrows them as a UserError containing the
    // 'If this is a new Worker, run `wrangler deploy` first' hint without the numeric code,
    // so match both shapes.
    return [];
  }
  console.warn(
    chalk.yellow(
      `Failed to list the remote Worker secrets; checking only the local payload against Cloudflare's limits.\n${(ret.stderr || ret.stdout).trim()}`
    )
  );
  return undefined;
}

/**
 * Remote secrets that stay attached to the new version: `wrangler deploy --secrets-file` is
 * additive, so every remote secret the outgoing payload does not overwrite keeps counting
 * against Cloudflare's combined variable+secret limit — except names that an effective var or
 * binding replaces.
 */
export function selectInheritedRemoteSecretNames(
  remoteSecretNames: string[],
  outgoingSecrets: Record<string, string>,
  effectiveVarKeys: readonly string[],
  bindingNames: readonly string[]
): string[] {
  const replacedNames = new Set([...effectiveVarKeys, ...bindingNames]);
  return remoteSecretNames.filter((name) => !Object.hasOwn(outgoingSecrets, name) && !replacedNames.has(name));
}

/**
 * Reading binExists prepends node_modules/.bin directories to project.env.PATH,
 * so the direct (non-shell) wrangler spawns resolve the local binary.
 */
function prepareLocalBinPath(project: Project): void {
  if (!project.binExists) {
    console.warn(chalk.yellow('node_modules/.bin not found; relying on PATH to resolve wrangler.'));
  }
}
