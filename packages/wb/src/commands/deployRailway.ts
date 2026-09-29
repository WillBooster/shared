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
import type { CheckEnvArgv } from './checkEnv.js';
import { checkEnv } from './checkEnv.js';
import { collectFnoxKeyNamesForProfile } from '../utils/fnoxToml.js';
import { isNonRailwayKey, pushRailwayVariables, resolveRailwayVariables } from './railwayEnv.js';

export const RAILWAY_IAC_FILE_PATH = '.railway/railway.ts';

const railwayTargetSchema = z.object({
  projectId: z.string().min(1),
  services: z
    .record(z.string(), z.string().min(1))
    .refine((services) => Object.keys(services).length > 0, 'declare at least one <environment>: <service name>'),
});

const environmentListSchema = z.object({
  environments: z.array(z.object({ id: z.string(), name: z.string() })),
});

const planReportSchema = z.object({
  diagnostics: z.array(z.object({ severity: z.string(), message: z.string() })).nullish(),
});

// The `--out` artifact that `config apply --plan` applies; its shape differs from the stdout report.
const planArtifactSchema = z.object({
  changeSet: z.object({
    changes: z.array(z.object({ summary: z.string(), severity: z.string(), kind: z.string() })),
  }),
  destructive: z.boolean(),
  // Set when the plan claims IaC ownership of a declared resource; the CLI applies it even without changes.
  claim: z.boolean().default(false),
});

// Everything else (variable deletions, volume detachments, resource creation or deletion, and kinds
// a newer Railway CLI may introduce) needs a human decision, so the check fails closed.
const ALLOWED_CHANGE_KINDS = new Set(['resource.update', 'variable.set']);

const upResultSchema = z.object({ deploymentId: z.string().min(1) });

const deploymentListSchema = z.array(z.object({ id: z.string(), status: z.string() }));

// SLEEPING only follows SUCCESS. Every other status, including unknown ones, keeps polling until the timeout.
const SUCCEEDED_STATUSES = new Set(['SUCCESS', 'SLEEPING']);
const FAILED_STATUSES = new Set(['FAILED', 'CRASHED', 'REMOVED', 'REMOVING', 'SKIPPED']);
const POLL_INTERVAL_MS = 5000;
// Bounds each CLI call after `railway up`, so a stalled one cannot hang the deploy. A status poll is
// further capped by the remaining deploy deadline; the log fetches after the verdict are not.
const CALL_TIMEOUT_MS = 60_000;
const deployTimeoutSecondsSchema = z.coerce.number().positive().default(1800);

interface RailwayContext {
  project: Project;
  projectId: string;
  services: Record<string, string>;
  binaryPath: string;
}

/**
 * Deploy the service `railwayTarget.services[WB_ENV]` from `.railway/railway.ts`: check the IaC
 * plan, sync fnox values, apply the re-checked plan when it has changes or claims ownership, then
 * `railway up` and wait until the created deployment succeeds. With `--dry-run`, only check the
 * plan of every environment in `railwayTarget.services`, never changing Railway.
 */
export async function deployRailway(argv: CheckEnvArgv & { dryRun?: boolean }, project: Project): Promise<void> {
  const context = await createRailwayContext(project);

  if (argv.dryRun) {
    // Plan every environment before failing, so one run reports every rejected change.
    const rejections: string[] = [];
    for (const envName of Object.keys(context.services)) {
      const { rejection } = await planAndCheck(context, envName);
      if (rejection) rejections.push(rejection);
    }
    if (rejections.length > 0) exitWithError(rejections.join('\n'));
    return;
  }

  const envName = project.env.WB_ENV ?? '';
  const serviceName = context.services[envName];
  if (!serviceName) {
    exitWithError(
      `WB_ENV (${envName}) must be one of the environments in railwayTarget.services: ${Object.keys(context.services).join(', ')}.`
    );
  }
  // Parse before changing anything: a malformed timeout must not abort a deploy after `railway up`.
  // An empty value, as a workflow passes for an unset variable, means the default.
  const timeoutSeconds = deployTimeoutSecondsSchema.parse(project.env.WB_RAILWAY_DEPLOY_TIMEOUT_SECONDS || undefined);
  // Ordinary env loading only warns when fnox cannot resolve a secret; deploying would then keep
  // stale values on Railway, so fail before changing anything. `env = false` keys are Railway's.
  await checkEnv(argv, { exportedOnly: true });
  // Check before pushing anything, then re-plan: syncing variables changes the environment's config
  // etag, which invalidates the first plan file.
  const firstPlan = await planAndCheck(context, envName);
  if (firstPlan.rejection) exitWithError(firstPlan.rejection);
  await syncVariables(context, argv, envName, serviceName);
  const { planPath, needsApply, rejection } = await planAndCheck(context, envName);
  if (rejection) exitWithError(rejection);
  // Applying a plan with changes always triggers a deployment of the previous image (the CLI has no
  // option to skip it), which `railway up` then supersedes; skipping a plan the CLI would treat as a
  // noop keeps one deployment.
  if (needsApply) await runRailway(context, ['config', 'apply', '--plan', planPath, '--yes'], envName);

  const targetArgs = [`--project=${context.projectId}`, `--environment=${envName}`, `--service=${serviceName}`];
  // `railway up --ci` exits non-zero when its log stream breaks, and may exit 0 before the deployment
  // finishes, so the verdict comes from the created deployment's status instead of its exit code.
  const upOutput = await runRailway(context, ['up', '--detach', '--json', ...targetArgs], envName, 'pipe');
  const { deploymentId } = upResultSchema.parse(JSON.parse(upOutput));
  const failure = await waitForDeployment(context, envName, targetArgs, deploymentId, timeoutSeconds);
  await printDeploymentLogs(context, envName, [deploymentId, '--build', '--lines=1000', ...targetArgs]);
  if (failure) {
    await printDeploymentLogs(context, envName, [deploymentId, '--deployment', '--lines=200', ...targetArgs]);
    exitWithError(failure);
  }
  console.info(chalk.green(`[${envName}] Railway deployment ${deploymentId} succeeded.`));
}

/** Poll the deployment until it reaches a terminal status; return why it failed, if it did. */
async function waitForDeployment(
  context: RailwayContext,
  envName: string,
  targetArgs: string[],
  deploymentId: string,
  timeoutSeconds: number
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastStatus: string | undefined;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return `Railway deployment ${deploymentId} did not finish within ${timeoutSeconds} seconds (last status: ${lastStatus ?? 'not listed'}); check it on Railway before deploying again. WB_RAILWAY_DEPLOY_TIMEOUT_SECONDS overrides the timeout.`;
    }
    const ret = await spawnRailway(
      context,
      ['deployment', 'list', '--json', '--limit=20', ...targetArgs],
      envName,
      'pipe',
      Math.min(CALL_TIMEOUT_MS, remainingMs)
    );
    // A transient API error or malformed output must not fail a deployment that is still running.
    let deployments: z.infer<typeof deploymentListSchema> | undefined;
    if (ret.status === 0) {
      try {
        deployments = deploymentListSchema.parse(JSON.parse(ret.stdout));
      } catch (error) {
        console.warn(chalk.yellow(`railway deployment list printed unexpected output: ${String(error)}`));
      }
    } else {
      console.warn(chalk.yellow(`railway deployment list failed (exit ${ret.status}): ${ret.stderr.trim()}`));
    }
    if (deployments) {
      // The list holds only the newest deployments, so absence proves nothing; removal shows as a status.
      const deployment = deployments.find(({ id }) => id === deploymentId);
      if (deployment && deployment.status !== lastStatus) {
        lastStatus = deployment.status;
        console.info(`[${envName}] Railway deployment ${deploymentId}: ${lastStatus}`);
        if (SUCCEEDED_STATUSES.has(lastStatus)) return;
        if (FAILED_STATUSES.has(lastStatus)) return `Railway deployment ${deploymentId} ended with ${lastStatus}.`;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(POLL_INTERVAL_MS, deadline - Date.now()))));
  }
}

async function printDeploymentLogs(context: RailwayContext, envName: string, args: string[]): Promise<void> {
  const ret = await spawnRailway(context, ['logs', ...args], envName, 'inherit', CALL_TIMEOUT_MS);
  if (ret.status !== 0) console.warn(chalk.yellow(`railway logs failed (exit ${ret.status}).`));
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

/** Plan `envName` and check the saved plan file; `rejection` explains why it must not be applied. */
async function planAndCheck(
  context: RailwayContext,
  envName: string
): Promise<{ planPath: string; needsApply: boolean; rejection?: string }> {
  const planPath = createPlanPath(envName);
  const output = await runRailway(context, ['config', 'plan', '--json', '--out', planPath], envName, 'pipe');
  for (const diagnostic of planReportSchema.parse(JSON.parse(output)).diagnostics ?? []) {
    console.warn(chalk.yellow(`[${envName}] ${diagnostic.severity}: ${diagnostic.message}`));
  }
  // Check the artifact that `config apply` applies, not the stdout report.
  const plan = planArtifactSchema.parse(JSON.parse(fs.readFileSync(planPath, 'utf8')));
  const { changes } = plan.changeSet;
  const needsApply = changes.length > 0 || plan.claim;
  for (const change of changes) console.info(`[${envName}] ${change.severity} ${change.kind}: ${change.summary}`);
  const rejectedChanges = changes.filter(
    (change) => change.severity !== 'safe' || !ALLOWED_CHANGE_KINDS.has(change.kind)
  );
  if (plan.destructive && rejectedChanges.length === 0) {
    return {
      planPath,
      needsApply,
      rejection: `The Railway plan for ${envName} is marked destructive although none of its changes is.`,
    };
  }
  if (rejectedChanges.length > 0) {
    return {
      planPath,
      needsApply,
      rejection: `The Railway plan for ${envName} contains changes that need a human decision:\n${rejectedChanges.map((change) => `- ${change.summary}`).join('\n')}\nDeclare what Railway should keep: a volume, domain, or service in ${RAILWAY_IAC_FILE_PATH}; a variable in fnox, or in railwayOnlyVariables when Railway supplies it (including RAILWAY_*, NIXPACKS_*, and CI keys). Delete it on Railway by hand only when it is no longer needed.`,
    };
  }
  console.info(chalk.green(`[${envName}] The Railway plan has ${changes.length} allowed change(s).`));
  return { planPath, needsApply };
}

let planDirPath: string | undefined;
let planCount = 0;

function createPlanPath(envName: string): string {
  if (!planDirPath) {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-railway-'));
    // An 'exit' listener also runs on wb's process.exit() error paths, which skip `finally` blocks.
    process.once('exit', () => fs.rmSync(dirPath, { force: true, recursive: true }));
    planDirPath = dirPath;
  }
  planCount++;
  return path.join(planDirPath, `${envName}-${planCount}.json`);
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
  const ret = await spawnRailway(context, args, envName, stdio);
  if (ret.status !== 0) {
    if (stdio === 'pipe') console.error(ret.stdout.trim());
    console.error(ret.stderr.trim());
    exitWithError(`railway ${args.slice(0, 2).join(' ')} failed (exit ${ret.status}).`);
  }
  return ret.stdout;
}

async function spawnRailway(
  context: RailwayContext,
  args: string[],
  envName: string,
  stdio: 'inherit' | 'pipe',
  timeoutMs?: number
): Promise<Awaited<ReturnType<typeof spawnAsync>>> {
  return spawnAsync(context.binaryPath, args, {
    cwd: context.project.dirPath,
    env: await buildRailwayEnv(context, envName),
    stdio,
    killOnExit: true,
    timeout: timeoutMs,
  });
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
