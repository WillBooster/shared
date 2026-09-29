import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readEnvironmentVariables, spawnAsync } from '@willbooster/shared-lib-node/src';
import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findSelfProject } from '../project.js';
import { selectFnoxSourcedKeys } from '../utils/envSources.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

// Railway injects its own system variables and platform-managed values; never mirror those back,
// and skip local-only keys. App variables (including DATABASE_URL, PORT) stay eligible because
// fnox is the source of truth — a repo that must NOT own a value (e.g. a Railway reference
// variable pointing at a linked database service) simply keeps it out of fnox.
const NON_RAILWAY_KEYS = new Set(['CI']);
const NON_RAILWAY_KEY_PREFIXES = ['RAILWAY_', 'NIXPACKS_'];

export function isNonRailwayKey(key: string): boolean {
  return NON_RAILWAY_KEYS.has(key) || NON_RAILWAY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Pick the variables to push to Railway from a resolved environment: drop empty/undefined values
 * (so a `KEY=` placeholder never blanks a real Railway variable) and Railway-managed keys, sorted
 * for a stable command and log line.
 */
export function selectRailwayVariables(envVars: Record<string, string | undefined>): [string, string][] {
  return Object.entries(envVars)
    .filter((entry): entry is [string, string] => {
      const [key, value] = entry;
      return typeof value === 'string' && value !== '' && !isNonRailwayKey(key);
    })
    .toSorted(([a], [b]) => a.localeCompare(b));
}

const builder = {} as const;

type RailwayEnvCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type RailwayEnvCommandArgv = ArgumentsCamelCase<RailwayEnvCommandOptions>;

export const railwayEnvCommand: CommandModule<unknown, RailwayEnvCommandOptions> = {
  command: 'railway-env',
  describe:
    'Sync the environment variables declared for the current WB_ENV (resolved from fnox) to the Railway service, keeping fnox the single source of truth. Railway-managed keys (RAILWAY_*, NIXPACKS_*, CI) are never pushed.',
  builder: (yargs) => yargs as unknown as Argv<RailwayEnvCommandOptions>,
  async handler(argv: RailwayEnvCommandArgv) {
    const project = findSelfProject(argv);
    if (!project) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }
    const envName = project.env.WB_ENV;
    if (!envName || envName === 'development' || envName === 'test') {
      console.error(
        chalk.red(`WB_ENV must name a deploy environment (e.g. staging or production), but is ${envName}.`)
      );
      process.exit(1);
    }

    const entries = resolveRailwayVariables(argv, project);
    if (entries.length === 0) {
      console.info(chalk.yellow('No environment variables to sync to Railway.'));
      return;
    }

    if (argv.dryRun) {
      console.info(
        chalk.cyan(
          `Would sync ${entries.length} variable(s) to Railway (${envName}): ${entries.map(([key]) => key).join(', ')}`
        )
      );
      return;
    }

    const cliCheck = await prepareRailwayCli(project.dirPath, project.env);
    if (cliCheck.status !== 0) {
      const detail = (cliCheck.stderr || cliCheck.stdout).trim();
      if (detail) console.error(detail);
      console.error(chalk.red(`Failed to prepare the Railway CLI (exit ${cliCheck.status}).`));
      process.exit(cliCheck.status ?? 1);
    }

    // The Railway CLI reads auth (RAILWAY_API_TOKEN) and defaults from the environment; pass the
    // project/service/environment explicitly when available so the command works unattended in CI.
    const targetArgs: string[] = [];
    if (project.env.RAILWAY_PROJECT_ID) targetArgs.push(`--project=${project.env.RAILWAY_PROJECT_ID}`);
    if (project.env.RAILWAY_SERVICE_ID) targetArgs.push(`--service=${project.env.RAILWAY_SERVICE_ID}`);
    targetArgs.push(`--environment=${envName}`);
    await pushRailwayVariables(['bunx', '@railway/cli'], targetArgs, entries, envName, {
      cwd: project.dirPath,
      env: project.env,
    });
  },
};

/** Set `entries` on a Railway service without redeploying it; exits on failure. */
export async function pushRailwayVariables(
  command: readonly [string, ...string[]],
  targetArgs: readonly string[],
  entries: readonly (readonly [string, string])[],
  envName: string,
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<void> {
  const [executable, ...commandArgs] = command;
  const keyNames = entries.map(([key]) => key).join(', ');
  // stdio: 'pipe' keeps the Railway CLI's variable listing (which echoes values) out of CI logs;
  // only key names are ever printed.
  const ret = await spawnAsync(
    executable,
    [
      ...commandArgs,
      'variables',
      '--skip-deploys',
      ...targetArgs,
      ...entries.flatMap(([key, value]) => ['--set', `${key}=${value}`]),
    ],
    { ...options, stdio: 'pipe', killOnExit: true }
  );
  if (ret.status !== 0) {
    console.error(chalk.red(`Failed to sync environment variables to Railway (exit ${ret.status}). Keys: ${keyNames}`));
    process.exit(ret.status ?? 1);
  }
  console.info(chalk.green(`Synced ${entries.length} variable(s) to Railway (${envName}): ${keyNames}`));
}

/** The fnox-declared variables of the current WB_ENV to push to Railway, with their effective values. */
export function resolveRailwayVariables(argv: EnvReaderOptions, project: Project): [string, string][] {
  // Restrict to variables declared in the project's fnox sources; ignore process.env so
  // Railway's own injected variables never leak in. The effective values come from project.env
  // (fnox-resolved for WB_ENV).
  const [envVars, envSources] = readEnvironmentVariables(argv, project.dirPath, { ignoreProcessEnv: true });
  // `mise env` is reported as a pseudo-source that mixes in host/tool variables such as PATH and
  // CARGO_HOME; those must never be pushed to Railway, so keep only fnox-declared keys.
  const fnoxKeys = selectFnoxSourcedKeys(envSources);
  for (const key of Object.keys(envVars)) {
    if (!fnoxKeys.has(key)) delete envVars[key];
  }
  // Exported environment variables win over configured values (matches wb deploy / gen-dev-vars).
  for (const key of Object.keys(envVars)) {
    const effectiveValue = project.env[key];
    if (effectiveValue !== undefined) envVars[key] = effectiveValue;
  }
  return selectRailwayVariables(envVars);
}

export async function prepareRailwayCli(
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<Awaited<ReturnType<typeof spawnAsync>>> {
  const runVersionCheck = (): ReturnType<typeof spawnAsync> =>
    spawnAsync('bunx', ['@railway/cli', '--version'], {
      cwd,
      env,
      stdio: 'pipe',
      killOnExit: true,
    });
  const result = await runVersionCheck();
  if (result.status !== 127) return result;

  const installDirPath = await findIncompleteRailwayCliInstall(result.stderr);
  if (!installDirPath) return result;

  console.warn(chalk.yellow('Railway CLI installation is incomplete; trusting its install script once.'));
  const trustResult = await spawnAsync('bun', ['add', '--trust', '@railway/cli'], {
    cwd: installDirPath,
    env,
    stdio: 'pipe',
    killOnExit: true,
  });
  if (trustResult.status !== 0) return trustResult;
  return runVersionCheck();
}

async function findIncompleteRailwayCliInstall(stderr: string): Promise<string | undefined> {
  const match = /could not find the CLI binary at (?<binaryPath>[^\r\n]+)/u.exec(stderr);
  const binaryPath = match?.groups?.binaryPath?.trim();
  if (!binaryPath) return;

  const binarySuffix = '/node_modules/@railway/cli/bin/railway';
  if (!binaryPath.endsWith(binarySuffix)) return;

  const installDirPath = binaryPath.slice(0, -binarySuffix.length);
  const [realInstallDirPath, realTmpDirPath] = await Promise.all([
    fs.realpath(installDirPath).catch(() => {}),
    fs.realpath(os.tmpdir()),
  ]);
  if (!realInstallDirPath) return;

  const expectedParentPath = path.join(realTmpDirPath, `bunx-${process.getuid!()}-@railway`);
  if (path.dirname(realInstallDirPath) !== expectedParentPath || !path.basename(realInstallDirPath).startsWith('cli@'))
    return;
  return realInstallDirPath;
}
