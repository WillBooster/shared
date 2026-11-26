import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCascade, spawnAsync } from '@willbooster/shared-lib-node/src';
import { getErrorMessage } from '@willbooster/shared-lib/src';
import chalk from 'chalk';
import { config } from 'dotenv';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';
import { z } from 'zod';

import type { Project } from '../project.js';
import { findSelfProjectOrExit } from '../project.js';
import { buildDrizzleKitCommand, usesDrizzleKitForD1 } from '../scripts/drizzleScripts.js';
import { buildViteCommand, usesViteBundler } from '../scripts/execution/cloudflareCommands.js';
import { runWithSpawn } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { isCI } from '../utils/ci.js';
import { buildCfCommand, buildD1MigrationOptions, getD1DatabaseId } from '../utils/cloudflare.js';
import type { CloudflareD1Database, D1Migrations, ResolvedCloudflareConfig } from '../utils/cloudflareConfig.js';
import {
  findCloudflareConfigPath,
  findUnmigratedWranglerConfigPath,
  formatD1DatabaseNames,
  readBuiltCloudflareConfig,
  resolveDeployCloudflareConfig,
  resolveWranglerAssetsDirectory,
  selectD1Migrations,
} from '../utils/cloudflareConfig.js';
import type { ContainersRollout } from '../utils/containerImages.js';
import { CONTAINER_IMAGE_ENV_PREFIX, planContainerImages } from '../utils/containerImages.js';
import { exitWithError } from '../utils/exit.js';
import { createSecretFreeBuildEnv } from '../utils/secretFreeEnv.js';
import { resolveDeclaredSecrets } from '../utils/workerSecrets.js';
import { deployRailway, RAILWAY_IAC_FILE_PATH } from './deployRailway.js';

/**
 * fnox keys that drive the deploy itself, so their absence from `cloudflare.config.ts` is not
 * worth reporting.
 */
const DEPLOY_CONTROL_KEYS = new Set([
  'CI',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'MISE_ENV',
  'NEXT_PUBLIC_WB_ENV',
  'NEXT_PUBLIC_WB_VERSION',
  'NODE_ENV',
  'PORT',
  'WB_ENV',
  'WB_VERSION',
]);

const builder = {
  'containers-rollout': {
    type: 'string',
    choices: ['none', 'gradual', 'immediate'],
    description:
      'Roll out containers: gradual/immediate deploy their images, built from committed contexts (reusing published ones); none, the default for a config with container images, keeps the deployed containers.',
  },
} as const;

type DeployCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type DeployCommandArgv = ArgumentsCamelCase<DeployCommandOptions>;

interface WorkerDeployContext {
  argv: DeployCommandArgv;
  project: Project;
  envName: string;
  resolvedConfig: ResolvedCloudflareConfig;
  /** The environment the config is evaluated and built under: restricted for a Vite build. */
  buildEnv: Readonly<Record<string, string | undefined>>;
  /**
   * The environment of every authenticated step and hook. cf's resource commands prefer an
   * exported CLOUDFLARE_ACCOUNT_ID over the config's accountId, while the upload uses the
   * account of the build, so this carries the account the Worker is deployed to.
   */
  authEnv: Readonly<Record<string, string | undefined>>;
  accountId: string | undefined;
}

export const deployCommand: CommandModule<unknown, DeployCommandOptions> = {
  command: 'deploy',
  describe:
    'Deploy to the WB_ENV environment. A Cloudflare Workers app (cloudflare.config.ts): validate secrets, build for the mode <WB_ENV>, apply remote D1 migrations, then deploy the build and its secrets atomically. A Railway service (.railway/railway.ts): check the IaC plan, sync fnox variables, apply the plan, then railway up and wait until the created deployment succeeds; --dry-run only checks the plan of every environment.',
  builder: (yargs) => yargs.options(builder) as unknown as Argv<DeployCommandOptions>,
  async handler(argv: DeployCommandArgv) {
    const project = findSelfProjectOrExit(argv);
    if (fs.existsSync(path.join(project.dirPath, RAILWAY_IAC_FILE_PATH))) {
      await deployRailway(argv, project);
      return;
    }
    if (!findCloudflareConfigPath(project)) {
      const wranglerConfigPath = findUnmigratedWranglerConfigPath(project);
      exitWithError(
        wranglerConfigPath
          ? `wb deploy no longer reads ${path.basename(wranglerConfigPath)}; convert the project with \`cf migrate\` first.`
          : `wb deploy supports only Cloudflare Workers apps (cloudflare.config.ts) and Railway services (${RAILWAY_IAC_FILE_PATH}).`
      );
    }
    const envName = project.env.WB_ENV;
    if (!envName || envName === 'development' || envName === 'test') {
      exitWithError(`WB_ENV must name a deploy environment (e.g. staging or production), but is ${envName}.`);
    }

    exportCloudflareEnvFiles(project);
    // Every environment below is a snapshot, so it must already carry the local bin directories
    // on PATH.
    prepareLocalBinPath(project);
    // The preflight must see the config the build will produce, so both evaluate it under the
    // same environment.
    const buildEnv = createBuildEnv(project, envName);
    const resolvedConfig = resolveCloudflareConfigOrExit(project, envName, buildEnv);
    const accountId = resolvedConfig.accountId ?? project.env.CLOUDFLARE_ACCOUNT_ID;
    const authEnv = { ...project.env, ...(accountId && { CLOUDFLARE_ACCOUNT_ID: accountId }) };
    const context: WorkerDeployContext = { argv, project, envName, resolvedConfig, buildEnv, authEnv, accountId };
    const d1Migrations = selectD1MigrationsOrExit(context);
    // Dry runs execute nothing authenticated, so they skip the credential preflight entirely.
    if (!argv.dryRun) assertDeployCredentials(project, d1Migrations.drizzleD1Database);

    // App-specific validation hook (e.g. secret pairs that must be both-set-or-both-empty).
    // The reusable deploy.yml already runs it on CI; run it here for local deploys.
    if (!isCI(project.env.CI) && project.packageJson.scripts?.['deploy/ci-setup']) {
      await runWithSpawn('YARN run deploy/ci-setup', project, argv, { env: authEnv });
    }

    const secrets = selectSecretsOrExit(context);
    const secretKeys = Object.keys(secrets).toSorted();
    await assertWithinCloudflareLimits(context, secrets, secretKeys);
    console.info(
      chalk.cyan(
        `Deploying ${resolvedConfig.workerName} (${envName}) with ${secretKeys.length} secrets: ${secretKeys.join(', ')}`
      )
    );

    await deployBuiltWorker(context, d1Migrations, secrets);
  },
};

async function deployBuiltWorker(
  context: WorkerDeployContext,
  d1Migrations: D1Migrations,
  secrets: Record<string, string>
): Promise<void> {
  await runGenCode(context);
  const { rollout, env: imageEnv } = await planContainerImagesOrExit(context);
  await buildWorker(context, imageEnv);
  assertBuildMatchesPreflight(context);
  await validateWorkerBuild(context, rollout);
  await applyD1Migrations(context, d1Migrations);
  if (!(await deployCodeAndSecrets(context, secrets, rollout))) return;
  await runPostDeployHook(context);
}

function createBuildEnv(project: Project, envName: string): Record<string, string | undefined> {
  const buildEnv = usesViteBundler(project) ? createViteBuildEnv(project, envName) : { ...project.env };
  // Only wb sets the image references, so that an exported one never replaces a Dockerfile image.
  for (const key of Object.keys(buildEnv)) {
    if (key.startsWith(CONTAINER_IMAGE_ENV_PREFIX)) delete buildEnv[key];
  }
  return buildEnv;
}

async function planContainerImagesOrExit(
  context: WorkerDeployContext
): Promise<Awaited<ReturnType<typeof planContainerImages>>> {
  const { project, envName, buildEnv, resolvedConfig } = context;
  // gen-code may have changed what the config reads, and images are published for this Worker.
  const generatedConfig = resolveCloudflareConfigOrExit(project, envName, buildEnv);
  assertSameDeployTarget(generatedConfig, resolvedConfig, 'cloudflare.config.ts after gen-code describes');
  try {
    return await planContainerImages(
      {
        ...context,
        rollout: context.argv.containersRollout as ContainersRollout | undefined,
        dryRun: context.argv.dryRun,
      },
      generatedConfig.containerImages
    );
  } catch (error) {
    exitWithError(getErrorMessage(error));
  }
}

function exportCloudflareEnvFiles(project: Project): void {
  // The values go into both process.env (inherited by everything wb spawns) and project.env
  // (the environment wb itself reads and passes explicitly); the latter is a cached snapshot
  // taken before this point, so writing only to process.env would leave wb's own preflight —
  // and any command spawned with project.env — without the token.
  const cloudflareEnvVars = readCloudflareEnvFiles(project.dirPath, project.rootDirPath);
  for (const [key, value] of Object.entries(cloudflareEnvVars)) {
    // ??= so that an explicitly exported empty value still wins over the file.
    process.env[key] ??= value;
    project.env[key] ??= value;
  }
}

function resolveCloudflareConfigOrExit(
  project: Project,
  envName: string,
  buildEnv: Record<string, string | undefined>
): ResolvedCloudflareConfig {
  try {
    const resolvedConfig = resolveDeployCloudflareConfig(project, envName, buildEnv);
    if (resolvedConfig) return resolvedConfig;
  } catch (error) {
    exitWithError(getErrorMessage(error));
  }
  exitWithError('cloudflare.config.ts not found.');
}

function selectD1MigrationsOrExit({ project, resolvedConfig }: WorkerDeployContext): D1Migrations {
  // A drizzle-orm dependency alone does not imply the project migrates D1 with drizzle-kit's
  // d1-http driver: the explicit marker is a drizzle config whose dialect/driver targets
  // sqlite / d1-http / durable-sqlite (see usesDrizzleKitForD1;
  // https://github.com/WillBooster/shared/issues/942). A drizzle config targeting another
  // database (e.g. PostgreSQL via Hyperdrive) leaves the D1 bindings unmanaged by wb deploy.
  const d1Migrations = selectD1Migrations(project, resolvedConfig.d1Databases, usesDrizzleKitForD1(project));
  if (d1Migrations.errorMessage) {
    exitWithError(d1Migrations.errorMessage);
  }
  if (d1Migrations.unmanagedD1Databases.length > 0) {
    // Say so out loud instead of silently deploying code against unmigrated databases: the
    // drizzle marker detection is heuristic (text scan of drizzle.config.*), so a project that
    // genuinely migrates D1 must be able to notice when no mechanism was selected.
    console.warn(
      chalk.yellow(
        `No D1 migration mechanism detected for ${formatD1DatabaseNames(d1Migrations.unmanagedD1Databases)} ` +
          '(no "wb.d1Migrations" entry in package.json, no flat SQL files in migrations/, and no drizzle config targeting sqlite/d1-http/durable-sqlite); wb deploy will not run D1 migrations for them.'
      )
    );
  }
  // Every target must be addressable before the first remote migration runs.
  for (const database of [
    ...d1Migrations.cfNativeD1Migrations.map((migration) => migration.database),
    ...(d1Migrations.drizzleD1Database ? [d1Migrations.drizzleD1Database] : []),
  ]) {
    getD1DatabaseIdOrExit(database);
  }
  return d1Migrations;
}

function assertDeployCredentials(project: Project, drizzleD1Database: CloudflareD1Database | undefined): void {
  // A drizzle-selected D1 database routes both the migration in applyD1Migrations and any deploy/post
  // hook through drizzle-kit's d1-http driver, which needs CLOUDFLARE_API_TOKEN even for
  // local deploys under a `cf auth login` session. Failing here keeps the fail-fast ordering: a
  // missing token must abort before the deploy goes live, not during migration or deploy/post
  // (https://github.com/WillBooster/shared/issues/956). cf-native projects must not require
  // the token locally: a `cf auth login` session suffices there.
  if (drizzleD1Database && !project.env.CLOUDFLARE_API_TOKEN) {
    exitWithError('CLOUDFLARE_API_TOKEN is required for remote drizzle-kit migrations.');
  }
  // cf reads its deprecated CF_API_TOKEN spelling only when CLOUDFLARE_API_TOKEN is not set at all.
  if (isCI(project.env.CI) && !(project.env.CLOUDFLARE_API_TOKEN ?? project.env.CF_API_TOKEN)) {
    exitWithError('CLOUDFLARE_API_TOKEN is required to deploy on CI.');
  }
}

function selectSecretsOrExit({ argv, project, envName, resolvedConfig }: WorkerDeployContext): Record<string, string> {
  // Resolve and validate all secrets before any build or remote mutation, so a missing
  // secret aborts the deploy instead of leaving a migrated database behind an old Worker.
  const { missingSecretNames, secrets, undeclaredFnoxKeys } = resolveDeclaredSecrets(
    argv,
    project,
    resolvedConfig.secretNames
  );
  if (missingSecretNames.length > 0) {
    // The profile the environment reader selected, which --cascade-env may set apart from WB_ENV.
    const cascade = resolveCascade(argv);
    const profileSources = cascade
      ? `fnox (base secrets or the ${cascade} profile), the mise environment ${cascade}`
      : "fnox's base secrets, the default mise environment";
    exitWithError(
      `Secrets that cloudflare.config.ts declares with bindings.secret() for ${envName} are not provided: ${missingSecretNames.join(', ')}. ` +
        `Set each (an explicitly empty value counts) in ${profileSources}, an exported environment variable, or a .env.cloudflare file beside cloudflare.config.ts or at the repository root, or stop declaring it for this mode.`
    );
  }
  // The deployed Worker must be able to report its version even when the config declares no
  // WB_VERSION entry of its own (e.g. `bindings.text(process.env.WB_VERSION ?? '')`).
  if (project.env.WB_VERSION && !resolvedConfig.envKeys.includes('WB_VERSION')) {
    secrets.WB_VERSION = project.env.WB_VERSION;
  }
  const unpushedKeys = undeclaredFnoxKeys.filter(
    (key) => !resolvedConfig.envKeys.includes(key) && !DEPLOY_CONTROL_KEYS.has(key)
  );
  if (unpushedKeys.length > 0) {
    console.info(
      `Not pushed because cloudflare.config.ts does not declare them with bindings.secret(): ${unpushedKeys.toSorted().join(', ')}`
    );
  }
  return secrets;
}

async function assertWithinCloudflareLimits(
  context: WorkerDeployContext,
  secrets: Record<string, string>,
  secretKeys: string[]
): Promise<void> {
  const { resolvedConfig } = context;
  // Cloudflare limits a bulk upload to 100 secrets, each variable/secret value to 5 KB, and
  // the combined variable+secret count to 128 (64 on the Free plan, which cannot be detected
  // here — hence a warning). Failing before any build or migration keeps an oversized payload
  // from aborting the deploy after remote migrations already ran.
  if (secretKeys.length > 100) {
    exitWithError(`Cloudflare accepts at most 100 secrets per deploy, but ${secretKeys.length} were selected.`);
  }
  const varEntries = Object.entries(resolvedConfig.vars);
  const oversizedKeys = [
    ...secretKeys.filter((key) => Buffer.byteLength(secrets[key] ?? '', 'utf8') > 5 * 1024),
    ...varEntries
      .filter(
        ([, value]) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') > 5 * 1024
      )
      .map(([key]) => key),
  ];
  if (oversizedKeys.length > 0) {
    exitWithError(`Variable or secret values exceed Cloudflare's 5 KB limit: ${oversizedKeys.join(', ')}`);
  }
  // Remote secrets absent from the payload may stay attached to the new version, so they
  // count against the combined limit too. Listing them needs an authenticated remote
  // round-trip, which dry runs skip; when the listing fails for any reason other than a
  // not-yet-created Worker, degrade to the local-only count instead of blocking a deploy that
  // cf itself might accept.
  const remoteSecretNames = context.argv.dryRun ? [] : await listRemoteWorkerSecretNames(context);
  const inheritedSecretNames = selectInheritedRemoteSecretNames(
    remoteSecretNames ?? [],
    secrets,
    resolvedConfig.envKeys
  );
  const combinedCount = new Set([...secretKeys, ...varEntries.map(([key]) => key)]).size + inheritedSecretNames.length;
  const inheritedNote =
    inheritedSecretNames.length > 0
      ? ` (including ${inheritedSecretNames.length} remote secrets kept from the previous version: ${inheritedSecretNames.join(', ')})`
      : '';
  if (combinedCount > 128) {
    exitWithError(
      `Cloudflare allows at most 128 variables and secrets combined, but ${combinedCount} were selected${inheritedNote}.`
    );
  }
  if (combinedCount > 64) {
    console.warn(
      chalk.yellow(`${combinedCount} variables and secrets${inheritedNote} exceed the Free plan's limit of 64.`)
    );
  }
}

async function runGenCode({ argv, project, envName }: WorkerDeployContext): Promise<void> {
  // gen-code keeps project.env: it may need a secret to fetch private inputs (e.g. prompt-study
  // clones a private repository), and it emits sources that the restricted build compiles.
  if (!project.packageJson.scripts?.['gen-code']) return;
  // MISE_ENV follows the deploy's WB_ENV so that the script's wb commands resolve the deploy
  // mode even inside a shell whose mise environment is another one (e.g. test).
  await runWithSpawn('YARN run gen-code', project, argv, { env: { ...project.env, MISE_ENV: envName } });
}

async function buildWorker(
  { argv, project, envName, buildEnv }: WorkerDeployContext,
  imageEnv: Record<string, string>
): Promise<void> {
  const usesVite = usesViteBundler(project);
  if (!usesVite && !argv.dryRun) ensureWranglerAssetsDirectory(project, envName, buildEnv);
  // Building before migrating keeps a build failure from leaving a migrated schema behind
  // the old Worker. The bundler runs directly, not through the package's `build` script.
  await runWithSpawn(
    usesVite ? buildViteCommand(project, envName, 'build') : buildCfCommand(envName, 'build'),
    project,
    argv,
    { env: { ...buildEnv, ...imageEnv } }
  );
}

/**
 * `cf build` (unlike `cf dev`) checks that the assets directory exists before it runs the build
 * command of `wrangler.config.ts`, which may be the one creating it, so the command still runs
 * exactly once.
 */
function ensureWranglerAssetsDirectory(
  project: Project,
  envName: string,
  buildEnv: Record<string, string | undefined>
): void {
  try {
    const assetsDirPath = resolveWranglerAssetsDirectory(project, envName, buildEnv);
    if (assetsDirPath) fs.mkdirSync(assetsDirPath, { recursive: true });
  } catch (error) {
    exitWithError(getErrorMessage(error));
  }
}

/**
 * The config is code, so the build's evaluation may differ from the preflight's even under the
 * same environment (e.g. it reads a file or the time). Secrets were validated and migrations are
 * planned for the preflight's Worker, so a built Worker that differs in what those steps used
 * must stop before any remote mutation. Other binding properties are not compared: wb neither
 * validates nor acts on them, and cf's two representations of them are not known to be equal.
 */
function assertBuildMatchesPreflight({ argv, project, resolvedConfig }: WorkerDeployContext): void {
  // On dry runs the build above is a printed no-op.
  if (argv.dryRun) return;
  const builtConfig = readBuiltCloudflareConfig(project);
  if (!builtConfig) {
    exitWithError('The build produced no default Worker under .cloudflare/output/v1.');
  }
  assertSameDeployTarget(builtConfig, resolvedConfig, 'The build produced');
}

function assertSameDeployTarget(
  config: ResolvedCloudflareConfig,
  resolvedConfig: ResolvedCloudflareConfig,
  source: string
): void {
  if (describeDeployTarget(config) !== describeDeployTarget(resolvedConfig)) {
    exitWithError(
      `${source} a Worker that differs from the one wb validated before building (name, account, binding names, text/JSON values, secret names, or D1 ids): make cloudflare.config.ts return the same configuration for the same mode and environment.`
    );
  }
}

function describeDeployTarget(config: ResolvedCloudflareConfig): string {
  return JSON.stringify([
    config.workerName,
    config.accountId,
    config.envKeys.toSorted(),
    Object.entries(config.vars).toSorted(([a], [b]) => a.localeCompare(b)),
    config.secretNames.toSorted(),
    config.d1Databases.map((database) => [database.binding, database.id]).toSorted(),
  ]);
}

async function validateWorkerBuild(
  { argv, project, envName, authEnv }: WorkerDeployContext,
  containersRollout: ContainersRollout | undefined
): Promise<void> {
  await runWithSpawn(
    buildCfCommand(
      envName,
      'deploy',
      `--prebuilt --dry-run${containersRollout ? ` --containers-rollout=${containersRollout}` : ''}`
    ),
    project,
    argv,
    { env: authEnv }
  );
}

/**
 * A Vite build ships client assets and inlines every public variable it sees (e.g. vinext's
 * NEXT_PUBLIC_* and next.config `env`), so the build gets no secret to inline in the first place.
 */
function createViteBuildEnv(project: Project, envName: string): Record<string, string> {
  // Vite loads these dotenv files itself, bypassing the environment it is given.
  const dotenvFiles = ['.env', '.env.local', `.env.${envName}`, `.env.${envName}.local`].filter((fileName) =>
    fs.existsSync(path.join(project.dirPath, fileName))
  );
  if (dotenvFiles.length > 0) {
    exitWithError(`Remove ${dotenvFiles.join(', ')}: the Vite build would load them into the deployed build.`);
  }
  let buildEnv: Record<string, string>;
  try {
    buildEnv = createSecretFreeBuildEnv(project, envName);
  } catch (error) {
    exitWithError(`The Vite build gets only plaintext fnox values: ${getErrorMessage(error)}`);
  }
  if (buildEnv.WB_VERSION) buildEnv.NEXT_PUBLIC_WB_VERSION ||= buildEnv.WB_VERSION;
  return buildEnv;
}

async function applyD1Migrations(
  { argv, project, envName, authEnv, accountId }: WorkerDeployContext,
  { cfNativeD1Migrations, drizzleD1Database }: D1Migrations
): Promise<void> {
  // Apply D1 migrations to the remote database with the project's single migration mechanism.
  // Migrations must be backward compatible: the old Worker serves traffic until
  // deployCodeAndSecrets replaces it.
  for (const { database, settings } of cfNativeD1Migrations) {
    // CI=true suppresses cf's interactive confirmation prompt.
    await runWithSpawn(
      `CI=true ${buildCfCommand(envName, 'd1 migrations apply', `${getD1DatabaseIdOrExit(database)} ${buildD1MigrationOptions(settings)}`)}`,
      project,
      argv,
      { env: authEnv }
    );
  }
  if (drizzleD1Database) {
    const databaseId = getD1DatabaseIdOrExit(drizzleD1Database);
    if (!accountId) {
      exitWithError(
        `CLOUDFLARE_ACCOUNT_ID (or accountId in cloudflare.config.ts) is required for remote drizzle-kit migrations to ${envName}.`
      );
    }
    await runWithSpawn(
      buildDrizzleKitCommand(
        project,
        'migrate',
        `CLOUDFLARE_D1_DATABASE_ID=${databaseId} CLOUDFLARE_ACCOUNT_ID=${accountId}`
      ),
      project,
      argv,
      { env: authEnv }
    );
  }
}

function getD1DatabaseIdOrExit(database: CloudflareD1Database): string {
  try {
    return getD1DatabaseId(database);
  } catch (error) {
    exitWithError(getErrorMessage(error));
  }
}

/** Resolves to false when a shutdown signal interrupted the deploy. */
async function deployCodeAndSecrets(
  { argv, project, envName, authEnv }: WorkerDeployContext,
  secrets: Record<string, string>,
  containersRollout: ContainersRollout | undefined
): Promise<boolean> {
  // Deploy the validated build and its secrets atomically (no post-deploy secret push that
  // could leave the new version running without — or with stale — secrets). The secrets JSON
  // goes through a mode-0600 file in a private temporary directory deleted right after the
  // deploy. Explicitly empty values stay in the payload: pushing '' is the only way to clear a
  // stale secret.
  const deployArgs = [
    'deploy',
    '--prebuilt',
    '--mode',
    envName,
    ...(containersRollout ? [`--containers-rollout=${containersRollout}`] : []),
    '--secrets-file',
  ];
  console.info(chalk.cyan(`Running: cf ${deployArgs.join(' ')} <temporary secrets file>`));
  if (argv.dryRun) return true;

  const { deployStatus, receivedShutdownSignal } = await runCfWithSecretsFile(project, authEnv, deployArgs, secrets);
  if (receivedShutdownSignal) {
    // Re-raise so the caller observes the same signal-derived exit status.
    process.kill(process.pid, receivedShutdownSignal);
    return false;
  }
  if (deployStatus !== 0) {
    // After runCfWithSecretsFile returns: process.exit inside it would skip its finally cleanup.
    console.error(chalk.red(`cf deploy failed with exit code ${deployStatus ?? 'unknown'}.`));
    process.exit(deployStatus ?? 1);
  }
  return true;
}

// code-gauge-allow functionCognitiveComplexity -- Signal forwarding and secret cleanup share subprocess state.
// code-gauge-allow functionNcss -- Keep the subprocess and its signal handlers in one cleanup scope.
async function runCfWithSecretsFile(
  project: Project,
  authEnv: WorkerDeployContext['authEnv'],
  deployArgs: string[],
  secrets: Record<string, string>
): Promise<{ deployStatus: number | undefined; receivedShutdownSignal: NodeJS.Signals | undefined }> {
  // 0o700 directory + 0o600 file: readable only by the deploying user. cf runs through an
  // async spawn (spawnSync would block the event loop, so a shutdown signal would kill the
  // process before any cleanup) and the directory is removed in a finally, so an interrupted
  // deploy cannot leave the plaintext secrets behind. Shutdown handling details:
  // - Handlers (including SIGHUP, on which Node also terminates by default) are installed
  //   BEFORE the file is written and use process.on, not once, so a repeated signal cannot
  //   fall back to default termination and bypass the finally cleanup.
  // - SIGHUP/SIGQUIT are forwarded to cf as SIGTERM: a launcher that does not relay them would
  //   orphan a deployment that keeps mutating the remote Worker after wb exits.
  // - The signal wb itself received is returned for the caller to re-raise: a CLI that catches
  //   SIGINT exits numerically (e.g. 143), which must not masquerade as an ordinary failure.
  const secretsDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-deploy-'));
  const shutdownSignals = ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGQUIT'] as const;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  let cfProcess: ReturnType<typeof spawn> | undefined;
  let receivedShutdownSignal: NodeJS.Signals | undefined;
  for (const signal of shutdownSignals) {
    const signalHandler = (): void => {
      receivedShutdownSignal ??= signal;
      if (cfProcess) {
        cfProcess.kill(signal === 'SIGINT' || signal === 'SIGTERM' ? signal : 'SIGTERM');
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
      cfProcess = spawn('cf', [...deployArgs, secretsFilePath], {
        cwd: project.dirPath,
        env: authEnv as NodeJS.ProcessEnv,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      cfProcess.on('error', (error) => {
        console.error(error);
        resolve(1);
      });
      cfProcess.on('exit', (code, signal) => {
        resolve(signal ? 1 : (code ?? undefined));
      });
    });
  } finally {
    for (const [shutdownSignal, signalHandler] of signalHandlers) {
      process.off(shutdownSignal, signalHandler);
    }
    fs.rmSync(secretsDirPath, { force: true, recursive: true });
  }
  return { deployStatus, receivedShutdownSignal };
}

async function runPostDeployHook({ argv, project, resolvedConfig, authEnv }: WorkerDeployContext): Promise<void> {
  // Optional post-deploy hook (e.g. seeding the remote D1 via drizzle's d1-http driver).
  if (!project.packageJson.scripts?.['deploy/post']) return;
  // The id is unambiguous only with a single D1 binding; with multiple, the hook must resolve
  // its target itself. A stale inherited id must not redirect the hook to another database.
  const hookD1Database = resolvedConfig.d1Databases.length === 1 ? resolvedConfig.d1Databases[0] : undefined;
  if (resolvedConfig.d1Databases.length > 1) {
    console.warn(chalk.yellow('Multiple D1 bindings exist; CLOUDFLARE_D1_DATABASE_ID is not set for deploy/post.'));
  }
  await runWithSpawn('YARN run deploy/post', project, argv, {
    env: { ...authEnv, CLOUDFLARE_D1_DATABASE_ID: hookD1Database?.id },
  });
}

/**
 * Read the Cloudflare API token that CI drops in a `.env.cloudflare` file (e.g. the reusable
 * deploy workflow's `file_path_1`), looking beside the Worker's config and at the monorepo
 * root — `file_path_1` is repo-relative, so both spellings occur in practice.
 * Nearer files win: a workspace may override the root token, never the reverse.
 */
export function readCloudflareEnvFiles(dirPath: string, rootDirPath: string | undefined): Record<string, string> {
  const envVars: Record<string, string> = {};
  for (const currentDirPath of new Set(rootDirPath ? [dirPath, rootDirPath] : [dirPath])) {
    const cloudflareEnvPath = path.join(currentDirPath, '.env.cloudflare');
    if (!fs.existsSync(cloudflareEnvPath)) continue;
    const parsed = config({ path: cloudflareEnvPath, processEnv: {}, quiet: true }).parsed ?? {};
    for (const [key, value] of Object.entries(parsed)) {
      envVars[key] ??= value;
    }
  }
  return envVars;
}

/**
 * List the secret names currently attached to the deploy target Worker. Returns undefined when
 * the listing fails for any reason other than the Worker not existing yet (first deploy), so
 * the caller can degrade to the local-only limit checks instead of blocking a deploy that
 * cf itself might accept. Failing closed instead would turn every transient listing failure
 * (network, a token without secret-read permission) into a deploy blocker; this preflight must
 * only ever add failures that cf itself would raise after the migrations.
 */
async function listRemoteWorkerSecretNames({
  argv,
  project,
  envName,
  resolvedConfig,
  authEnv,
}: WorkerDeployContext): Promise<string[] | undefined> {
  const listArgs = ['workers', 'secrets', 'list', '--mode', envName, '--worker', resolvedConfig.workerName];
  console.info(chalk.cyan(`Running: cf ${listArgs.join(' ')}`));
  let ret;
  try {
    ret = await spawnAsync('cf', listArgs, {
      // The Worker's directory, as for the upload: cf selects an OAuth profile bound to it.
      cwd: project.dirPath,
      env: authEnv as NodeJS.ProcessEnv,
      stdio: 'pipe',
      killOnExit: true,
      verbose: argv.verbose,
    });
  } catch (error) {
    console.warn(
      chalk.yellow(
        `Failed to run cf to list remote secrets; checking only the local payload against Cloudflare's limits.\n${getErrorMessage(error)}`
      )
    );
    return undefined;
  }
  if (ret.status === 0) {
    const names = parseSecretNames(ret.stdout);
    if (names) return names;
  } else if (/\b100(07|90)\b/u.test(ret.stdout + ret.stderr)) {
    // The Worker does not exist yet, so a first deploy inherits nothing: the Cloudflare API
    // answers 10007 (workers.api.error.service_not_found) or 10090
    // (workers.api.error.script_not_found).
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
 * cf evaluates the config for this command, whose own output (progress text without a newline,
 * bracketed log lines, even JSON arrays) may precede the listing on stdout: the listing is the
 * first `[` from which the rest of stdout parses as the expected array.
 */
function parseSecretNames(stdout: string): string[] | undefined {
  for (const { index } of stdout.matchAll(/\[/gu)) {
    const parsed = z.array(z.looseObject({ name: z.string() })).safeParse(parseJsonOrUndefined(stdout.slice(index)));
    if (parsed.success) return parsed.data.map(({ name }) => name);
  }
  return undefined;
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Remote secrets that stay attached to the new version: every remote secret the outgoing
 * payload does not overwrite keeps counting against Cloudflare's combined variable+secret
 * limit — except names that an entry of the config's `env` replaces.
 */
export function selectInheritedRemoteSecretNames(
  remoteSecretNames: string[],
  outgoingSecrets: Record<string, string>,
  envKeys: readonly string[]
): string[] {
  const replacedNames = new Set(envKeys);
  return remoteSecretNames.filter((name) => !Object.hasOwn(outgoingSecrets, name) && !replacedNames.has(name));
}

/**
 * Reading binExists prepends node_modules/.bin directories to project.env.PATH, so the
 * environments copied from it resolve the local cf binary.
 */
function prepareLocalBinPath(project: Project): void {
  if (!project.binExists) {
    console.warn(chalk.yellow('node_modules/.bin not found; relying on PATH to resolve cf.'));
  }
}
