import { readEnvironmentVariables, spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

import { readEnvExampleKeys } from './genDevVars.js';

// Railway injects its own system variables and platform-managed values; never mirror those back,
// and skip local-only keys. App variables (including DATABASE_URL, PORT) stay eligible because
// fnox is the source of truth — a repo that must NOT own a value (e.g. a Railway reference
// variable pointing at a linked database service) simply keeps it out of fnox/.env.example.
const NON_RAILWAY_KEYS = new Set(['CI']);
const NON_RAILWAY_KEY_PREFIXES = ['RAILWAY_', 'NIXPACKS_'];

function isNonRailwayKey(key: string): boolean {
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
    'Sync the environment variables declared for the current WB_ENV (resolved from fnox/.env) to the Railway service, keeping fnox the single source of truth. Railway-managed keys (RAILWAY_*, NIXPACKS_*, CI) are never pushed.',
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

    // Restrict to variables declared in .env / .env.example (wb's environment contract); ignore
    // process.env so Railway's own injected variables never leak in. The effective values come
    // from project.env (fnox-resolved for WB_ENV). Mirrors wb gen-dev-vars.
    const [envVars] = readEnvironmentVariables(argv, project.dirPath, { ignoreProcessEnv: true });
    for (const key of Object.keys(envVars)) {
      const effectiveValue = project.env[key];
      if (effectiveValue !== undefined) envVars[key] = effectiveValue;
    }
    // fnox repos keep values out of committed files, so the declared key list lives in
    // .env.example; CI also supplies these as workflow env. project.env carries the resolved value.
    for (const key of [...readEnvExampleKeys(project), 'WB_ENV', 'NEXT_PUBLIC_WB_ENV']) {
      const effectiveValue = project.env[key];
      if (envVars[key] === undefined && effectiveValue !== undefined) envVars[key] = effectiveValue;
    }

    const entries = selectRailwayVariables(envVars);
    if (entries.length === 0) {
      console.info(chalk.yellow('No environment variables to sync to Railway.'));
      return;
    }

    const keyNames = entries.map(([key]) => key);
    if (argv.dryRun) {
      console.info(
        chalk.cyan(`Would sync ${entries.length} variable(s) to Railway (${envName}): ${keyNames.join(', ')}`)
      );
      return;
    }

    // The Railway CLI reads auth (RAILWAY_API_TOKEN) and defaults from the environment; pass the
    // project/service/environment explicitly when available so the command works unattended in CI.
    const contextArgs: string[] = ['--skip-deploys'];
    if (process.env.RAILWAY_PROJECT_ID) contextArgs.push(`--project=${process.env.RAILWAY_PROJECT_ID}`);
    if (process.env.RAILWAY_SERVICE_ID) contextArgs.push(`--service=${process.env.RAILWAY_SERVICE_ID}`);
    contextArgs.push(`--environment=${envName}`);
    const setArgs = entries.flatMap(([key, value]) => ['--set', `${key}=${value}`]);

    // stdio: 'pipe' keeps the Railway CLI's variable listing (which echoes values) out of CI logs;
    // this command only ever prints key names, never values.
    const ret = await spawnAsync('bunx', ['@railway/cli', 'variables', ...contextArgs, ...setArgs], {
      cwd: project.dirPath,
      env: process.env,
      stdio: 'pipe',
      killOnExit: true,
    });
    if (ret.status !== 0) {
      console.error(
        chalk.red(`Failed to sync environment variables to Railway (exit ${ret.status}). Keys: ${keyNames.join(', ')}`)
      );
      process.exit(ret.status ?? 1);
    }
    console.info(chalk.green(`Synced ${entries.length} variable(s) to Railway (${envName}): ${keyNames.join(', ')}`));
  },
};
