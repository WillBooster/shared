import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import { z } from 'zod';

import type { Project } from '../project.js';
import { collectFnoxKeyNamesForProfile } from '../utils/fnoxToml.js';
import { isNonRailwayKey, pushRailwayVariables, resolveRailwayVariables } from './railwayEnv.js';

export const RAILWAY_IAC_FILE_PATH = '.railway/railway.ts';

const railwayTargetSchema = z.object({
  projectId: z.string().min(1),
  services: z.record(z.string(), z.string().min(1)),
});

const environmentListSchema = z.object({
  environments: z.array(z.object({ id: z.string(), name: z.string() })),
});

const planSchema = z.object({
  changeSet: z.object({
    changes: z.array(z.object({ summary: z.string(), severity: z.string(), kind: z.string() })),
  }),
  diagnostics: z.array(z.object({ severity: z.string(), message: z.string() })).nullish(),
});

// Everything else (variable deletions, volume detachments, resource creation or deletion, and kinds
// a newer Railway CLI may introduce) needs a human decision, so the check fails closed.
const ALLOWED_CHANGE_KINDS = new Set(['resource.update', 'variable.set']);

interface RailwayContext {
  project: Project;
  projectId: string;
  services: Record<string, string>;
  binaryPath: string;
}

/**
 * Deploy the service `railwayTarget.services[WB_ENV]` from `.railway/railway.ts`: check the IaC
 * plan, sync fnox values, apply the re-checked plan, then `railway up`. With `--dry-run`, only
 * check the plan of every environment in `railwayTarget.services`, never changing Railway.
 */
export async function deployRailway(argv: EnvReaderOptions & { dryRun?: boolean }, project: Project): Promise<void> {
  const context = await createRailwayContext(project);

  if (argv.dryRun) {
    for (const envName of Object.keys(context.services)) {
      await planAndCheck(context, envName);
    }
    return;
  }

  const envName = project.env.WB_ENV ?? '';
  const serviceName = context.services[envName];
  if (!serviceName) {
    exitWithError(
      `WB_ENV (${envName}) must be one of the environments in railwayTarget.services: ${Object.keys(context.services).join(', ')}.`
    );
  }
  // Check before pushing anything, then re-plan: syncing variables changes the environment's config
  // etag, which invalidates the first plan file.
  await planAndCheck(context, envName);
  await syncVariables(context, argv, envName, serviceName);
  const planPath = await planAndCheck(context, envName);
  await runRailway(context, ['config', 'apply', '--plan', planPath, '--yes'], envName);
  await runRailway(
    context,
    ['up', '--ci', `--project=${context.projectId}`, `--environment=${envName}`, `--service=${serviceName}`],
    envName
  );
}

async function createRailwayContext(project: Project): Promise<RailwayContext> {
  const filePath = path.join(project.dirPath, RAILWAY_IAC_FILE_PATH);
  const iacModule = (await import(pathToFileURL(filePath).href)) as { railwayTarget?: unknown };
  const result = railwayTargetSchema.safeParse(iacModule.railwayTarget);
  if (!result.success) {
    exitWithError(
      `${RAILWAY_IAC_FILE_PATH} must export railwayTarget = { projectId, services: { <environment>: <service name> } }: ${result.error.message}`
    );
  }
  const exportedProjectId = project.env.RAILWAY_PROJECT_ID;
  if (exportedProjectId && exportedProjectId !== result.data.projectId) {
    exitWithError(
      `RAILWAY_PROJECT_ID (${exportedProjectId}) differs from railwayTarget.projectId (${result.data.projectId}); remove it from the deploy workflow.`
    );
  }

  let packageJsonPath: string;
  try {
    packageJsonPath = createRequire(path.join(project.dirPath, 'package.json')).resolve('@railway/cli/package.json');
  } catch {
    exitWithError('Add @railway/cli to devDependencies to deploy to Railway.');
  }
  return { project, ...result.data, binaryPath: path.join(path.dirname(packageJsonPath), 'bin', 'railway') };
}

/** Plan `envName` and exit unless every change is allowed; returns the saved plan file. */
async function planAndCheck(context: RailwayContext, envName: string): Promise<string> {
  const planPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-railway-')), 'plan.json');
  const output = await runRailway(context, ['config', 'plan', '--json', '--out', planPath], envName, 'pipe');
  const plan = planSchema.parse(JSON.parse(output));
  for (const diagnostic of plan.diagnostics ?? []) {
    console.warn(chalk.yellow(`[${envName}] ${diagnostic.severity}: ${diagnostic.message}`));
  }
  const { changes } = plan.changeSet;
  for (const change of changes) console.info(`[${envName}] ${change.severity} ${change.kind}: ${change.summary}`);
  const rejectedChanges = changes.filter(
    (change) => change.severity !== 'safe' || !ALLOWED_CHANGE_KINDS.has(change.kind)
  );
  if (rejectedChanges.length > 0) {
    exitWithError(
      `The Railway plan for ${envName} contains changes that need a human decision (e.g. declare a deleted variable in fnox, or delete it on Railway by hand):\n${rejectedChanges.map((change) => `- ${change.summary}`).join('\n')}`
    );
  }
  console.info(chalk.green(`[${envName}] The Railway plan has ${changes.length} allowed change(s).`));
  return planPath;
}

async function syncVariables(
  context: RailwayContext,
  argv: EnvReaderOptions,
  envName: string,
  serviceName: string
): Promise<void> {
  const variables = new Map(resolveRailwayVariables(argv, context.project));
  if (context.project.env.WB_VERSION) variables.set('WB_VERSION', context.project.env.WB_VERSION);
  if (variables.size === 0) return;
  await pushRailwayVariables(
    [context.binaryPath],
    [`--project=${context.projectId}`, `--environment=${envName}`, `--service=${serviceName}`],
    [...variables],
    envName,
    { cwd: context.project.dirPath, env: await buildRailwayEnv(context, envName) }
  );
}

async function runRailway(
  context: RailwayContext,
  args: string[],
  envName: string,
  stdio: 'inherit' | 'pipe' = 'inherit'
): Promise<string> {
  const env = await buildRailwayEnv(context, envName);
  const ret = await spawnAsync(context.binaryPath, args, {
    cwd: context.project.dirPath,
    env,
    stdio,
    killOnExit: true,
  });
  if (ret.status !== 0) {
    if (stdio === 'pipe') console.error(ret.stdout.trim());
    console.error(ret.stderr.trim());
    exitWithError(`railway ${args.slice(0, 2).join(' ')} failed (exit ${ret.status}).`);
  }
  return ret.stdout;
}

async function buildRailwayEnv(context: RailwayContext, envName: string): Promise<NodeJS.ProcessEnv> {
  const variableNames = new Set([
    ...collectFnoxKeyNamesForProfile(context.project.dirPath, context.project.rootDirPath, envName).filter(
      (key) => !isNonRailwayKey(key)
    ),
    'WB_VERSION',
  ]);
  return {
    ...buildBaseEnv(context),
    RAILWAY_ENVIRONMENT_ID: await resolveEnvironmentId(context, envName),
    WB_ENV: envName,
    WB_RAILWAY_VARIABLE_NAMES: JSON.stringify([...variableNames]),
  };
}

let environmentIdsPromise: Promise<Map<string, string>> | undefined;

async function resolveEnvironmentId(context: RailwayContext, envName: string): Promise<string> {
  environmentIdsPromise ??= listEnvironmentIds(context);
  const environmentIds = await environmentIdsPromise;
  const environmentId = environmentIds.get(envName);
  if (!environmentId) exitWithError(`Railway project ${context.projectId} has no environment named ${envName}.`);
  return environmentId;
}

async function listEnvironmentIds(context: RailwayContext): Promise<Map<string, string>> {
  const ret = await spawnAsync(context.binaryPath, ['environment', 'list', '--json'], {
    cwd: context.project.dirPath,
    env: buildBaseEnv(context),
    stdio: 'pipe',
    killOnExit: true,
  });
  if (ret.status !== 0) {
    console.error(ret.stderr.trim());
    exitWithError(`Failed to list the environments of Railway project ${context.projectId}.`);
  }
  const { environments } = environmentListSchema.parse(JSON.parse(ret.stdout));
  return new Map(environments.map((environment) => [environment.name, environment.id]));
}

function buildBaseEnv(context: RailwayContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...context.project.env,
    // The `railway` SDK checks the CLI version by running `$_ --version`.
    _: context.binaryPath,
    RAILWAY_PROJECT_ID: context.projectId,
  };
  // The deploy workflow may still export the environment name and the service ID; the CLI then
  // targets them instead of what is resolved here.
  delete env.RAILWAY_ENVIRONMENT_ID;
  delete env.RAILWAY_SERVICE_ID;
  return env;
}

function exitWithError(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}
