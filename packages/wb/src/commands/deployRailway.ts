import childProcess from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
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

const deploymentListSchema = z.array(z.object({ id: z.string(), status: z.string(), createdAt: z.string() }));

// `railway up --json` and `railway logs --json` print one such object per log line.
const logLineSchema = z.object({ message: z.string() });
// `railway up --json` ends with this line once the deployment succeeds, fails, or crashes. Progress log lines
// also carry a `status`, so a line with a `message` is always a log line.
const upStatusLineSchema = z.object({ status: z.enum(['success', 'failed', 'crashed']) });

// SLEEPING only follows SUCCESS. A status in neither set, including an unknown one, keeps checking until
// the timeout.
const SUCCEEDED_STATUSES = new Set(['SUCCESS', 'SLEEPING']);
const FAILED_STATUSES = new Set(['FAILED', 'CRASHED', 'REMOVED', 'REMOVING', 'SKIPPED']);
// Polls around `config apply`, which wait at most 60 seconds in total.
const POLL_INTERVAL_MS = 5000;
// Railway creates the apply-triggered deployment seconds after `config apply` returns.
const APPLIED_DEPLOYMENT_TIMEOUT_MS = 60_000;
// Status checks after `railway up` are infrequent: several repositories deploying at once with one token
// otherwise exhaust Railway's API rate limit. A rate-limited check doubles the interval up to the maximum.
const STATUS_CHECK_INTERVAL_MS = 30_000;
const MAX_STATUS_CHECK_INTERVAL_MS = 300_000;
const RATE_LIMIT_PATTERN = /ratelimit/i;
// Bound each deployment list and log fetch, so a stalled one cannot hang the deploy. One around
// `config apply` is kept short so that a stalled one leaves the 60-second wait time for more polls.
const CALL_TIMEOUT_MS = 60_000;
const SHORT_CALL_TIMEOUT_MS = 15_000;
// Railway occasionally rejects a fresh plan with this message although nothing changed the environment
// since the plan, apparently from a stale read on its side; a rejected apply changes nothing.
const STALE_PLAN_MESSAGE = 'The environment changed since this plan was computed';
const MAX_APPLY_ATTEMPTS = 3;
const STALE_PLAN_RETRY_DELAY_MS = 5000;
const deployTimeoutSecondsSchema = z.coerce.number().positive().default(1800);

interface RailwayUpResult {
  status?: z.infer<typeof upStatusLineSchema>['status'];
  exitCode: number | null;
  exitDescription: string;
  startedAt: number;
}

interface RailwayContext {
  project: Project;
  projectId: string;
  services: Record<string, string>;
  binaryPath: string;
}

/**
 * Deploy the service `railwayTarget.services[WB_ENV]` from `.railway/railway.ts`: check the IaC
 * plan, sync fnox values, apply the re-checked plan when it has changes or claims ownership (re-planning
 * and re-checking when Railway rejects the plan as stale) and wait up to 60 seconds for a deployment of the
 * service it triggers (an apply that changes only other services or ownership metadata may trigger none),
 * then `railway up --json`, printing its build logs live, and judge the deploy by the status line it ends
 * with. With `--dry-run`, only check the plan of every environment in `railwayTarget.services`, never
 * changing Railway.
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
  const targetArgs = [`--project=${context.projectId}`, `--environment=${envName}`, `--service=${serviceName}`];
  await applyRecheckedPlan(context, envName, serviceName, targetArgs);
  const deadline = Date.now() + timeoutSeconds * 1000;
  const up = await runRailwayUp(context, envName, targetArgs, deadline);
  if (up.status === 'success' && up.exitCode === 0) {
    console.info(chalk.green(`[${envName}] The Railway deployment succeeded.`));
    return;
  }
  if (up.status) {
    exitWithError(`railway up reported the Railway deployment as ${up.status} (${up.exitDescription}).`);
  }
  console.warn(
    chalk.yellow(
      `[${envName}] railway up ended (${up.exitDescription}) without reporting the deployment's result; checking it on Railway.`
    )
  );
  const deploymentId = await waitForDeployment(context, envName, targetArgs, up.startedAt, deadline, timeoutSeconds);
  console.info(chalk.green(`[${envName}] Railway deployment ${deploymentId} succeeded.`));
}

/**
 * Re-plan and re-check `envName`, apply the plan when it has changes or claims ownership, and wait for
 * the deployment it triggers. A plan Railway rejects as stale is never applied again: a fresh plan is
 * checked instead, up to `MAX_APPLY_ATTEMPTS` applies in total.
 */
async function applyRecheckedPlan(
  context: RailwayContext,
  envName: string,
  serviceName: string,
  targetArgs: string[]
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const { planPath, needsApply, rejection } = await planAndCheck(context, envName);
    if (rejection) exitWithError(rejection);
    // Applying a plan with changes triggers a deployment of the previous image (the CLI has no option to
    // skip it), which `railway up` must supersede; skipping a plan the CLI would treat as a noop keeps one
    // deployment.
    if (!needsApply) return;
    // Only a list taken before the apply tells the deployment it triggers apart from earlier ones.
    const knownIds = await pollDeployments(
      context,
      envName,
      targetArgs,
      Date.now() + APPLIED_DEPLOYMENT_TIMEOUT_MS,
      (deployments) => new Set(deployments.map(({ id }) => id))
    );
    if (!knownIds) {
      exitWithError(
        `Could not list the Railway deployments of ${serviceName} within ${APPLIED_DEPLOYMENT_TIMEOUT_MS / 1000} seconds; the Railway plan was not applied.`
      );
    }
    const args = ['config', 'apply', '--plan', planPath, '--yes'];
    const ret = await spawnRailway(context, args, envName, 'tee');
    if (ret.status === 0) {
      await waitForAppliedDeployment(context, envName, targetArgs, knownIds);
      return;
    }
    if (attempt >= MAX_APPLY_ATTEMPTS || !ret.stderr.includes(STALE_PLAN_MESSAGE))
      exitWithRailwayError(args, ret.status);
    console.warn(
      chalk.yellow(
        `[${envName}] Railway rejected the plan as stale (apply attempt ${attempt}/${MAX_APPLY_ATTEMPTS}); re-planning in ${STALE_PLAN_RETRY_DELAY_MS / 1000} seconds.`
      )
    );
    await sleep(STALE_PLAN_RETRY_DELAY_MS);
  }
}

/**
 * Wait until a deployment missing from `knownIds` appears, so that `railway up` creates the newest
 * deployment. `config apply` returns before Railway creates the deployment it triggers; one created
 * after `railway up`'s supersedes the uploaded code.
 */
async function waitForAppliedDeployment(
  context: RailwayContext,
  envName: string,
  targetArgs: string[],
  knownIds: Set<string>
): Promise<void> {
  const deployment = await pollDeployments(
    context,
    envName,
    targetArgs,
    Date.now() + APPLIED_DEPLOYMENT_TIMEOUT_MS,
    (deployments) => deployments.find(({ id }) => !knownIds.has(id))
  );
  if (deployment) {
    console.info(
      `[${envName}] config apply triggered Railway deployment ${deployment.id} (${deployment.status}); railway up supersedes it.`
    );
    return;
  }
  console.warn(
    chalk.yellow(
      `[${envName}] No deployment triggered by config apply was seen within ${APPLIED_DEPLOYMENT_TIMEOUT_MS / 1000} seconds; running railway up.`
    )
  );
}

/**
 * Poll the newest deployments of the target service around `config apply` until `find` returns a
 * value, or return `undefined` once `deadline` passes.
 */
async function pollDeployments<T>(
  context: RailwayContext,
  envName: string,
  targetArgs: string[],
  deadline: number,
  find: (deployments: z.infer<typeof deploymentListSchema>) => T | undefined
): Promise<T | undefined> {
  while (Date.now() < deadline) {
    const callTimeoutMs = Math.max(1, Math.min(SHORT_CALL_TIMEOUT_MS, deadline - Date.now()));
    const { deployments } = await listDeployments(context, envName, targetArgs, callTimeoutMs);
    const found = deployments && find(deployments);
    if (found !== undefined) return found;
    await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
  }
  return undefined;
}

/**
 * Run `railway up --json`, printing the message of each build log line as it arrives, and return the
 * status of its final line, if it printed one. It is stopped at `deadline`.
 */
async function runRailwayUp(
  context: RailwayContext,
  envName: string,
  targetArgs: string[],
  deadline: number
): Promise<RailwayUpResult> {
  const startedAt = Date.now();
  const proc = childProcess.spawn(context.binaryPath, ['up', '--json', ...targetArgs], {
    cwd: context.project.dirPath,
    env: await buildRailwayEnv(context, envName),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, deadline - startedAt);
  const stopOnExit = (): void => {
    proc.kill();
  };
  process.once('exit', stopOnExit);
  let status: RailwayUpResult['status'];
  const lines = readline.createInterface({ input: proc.stdout });
  let waitingForDrain = false;
  lines.on('line', (line) => {
    const json = parseJson(line);
    const logLine = logLineSchema.safeParse(json);
    const statusLine = upStatusLineSchema.safeParse(json);
    if (!logLine.success && statusLine.success) {
      status = statusLine.data.status;
      return;
    }
    // Stop reading while a slow consumer of wb's output catches up, instead of buffering without bound.
    // Lines readline already buffered still arrive after pause(), so only the first one waits for drain.
    if (!process.stdout.write(`${logLine.success ? logLine.data.message.trimEnd() : line}\n`) && !waitingForDrain) {
      waitingForDrain = true;
      lines.pause();
      process.stdout.once('drain', () => {
        waitingForDrain = false;
        lines.resume();
      });
    }
  });
  let exitCode: number | null;
  let signal: NodeJS.Signals | null;
  try {
    [exitCode, signal] = (await once(proc, 'close')) as [number | null, NodeJS.Signals | null];
  } finally {
    clearTimeout(timer);
    process.off('exit', stopOnExit);
  }
  const exitDescription = timedOut
    ? 'stopped at the deploy timeout'
    : exitCode === null
      ? `signal ${signal}`
      : `exit ${exitCode}`;
  return { status, exitCode, exitDescription, startedAt };
}

/**
 * Identify the deployment `railway up` created as the only one of the service created since `upStartedAt`
 * (the deploy workflow serializes deploys to a service), check its status until it is terminal, print its
 * build logs, and return its ID if it succeeded. A rate-limited check doubles the interval to the next one.
 */
async function waitForDeployment(
  context: RailwayContext,
  envName: string,
  targetArgs: string[],
  upStartedAt: number,
  deadline: number,
  timeoutSeconds: number
): Promise<string> {
  let deploymentId: string | undefined;
  let lastStatus: string | undefined;
  let intervalMs = STATUS_CHECK_INTERVAL_MS;
  for (;;) {
    // The first check runs even when `railway up` used up the time.
    const callTimeoutMs = Math.max(SHORT_CALL_TIMEOUT_MS, Math.min(CALL_TIMEOUT_MS, deadline - Date.now()));
    const { deployments, rateLimited } = await listDeployments(context, envName, targetArgs, callTimeoutMs);
    if (deployments) {
      deploymentId ??= identifyCreatedDeployment(deployments, upStartedAt);
      // The list holds only the newest deployments, so absence proves nothing; removal shows as a status.
      const status = deployments.find(({ id }) => id === deploymentId)?.status;
      if (status && status !== lastStatus) {
        lastStatus = status;
        console.info(`[${envName}] Railway deployment ${deploymentId}: ${status}`);
      }
      if (status && (SUCCEEDED_STATUSES.has(status) || FAILED_STATUSES.has(status))) {
        await printBuildLogs(context, envName, targetArgs, deploymentId);
        if (FAILED_STATUSES.has(status)) exitWithError(`Railway deployment ${deploymentId} ended with ${status}.`);
        return deploymentId;
      }
    }
    if (Date.now() >= deadline) {
      exitWithError(
        `Railway deployment ${deploymentId ?? 'created by railway up'} did not finish within ${timeoutSeconds} seconds (last status: ${lastStatus ?? 'not listed'}); check it on Railway before deploying again. WB_RAILWAY_DEPLOY_TIMEOUT_SECONDS overrides the timeout.`
      );
    }
    intervalMs = rateLimited ? Math.min(intervalMs * 2, MAX_STATUS_CHECK_INTERVAL_MS) : STATUS_CHECK_INTERVAL_MS;
    if (rateLimited) {
      console.warn(
        chalk.yellow(
          `[${envName}] Railway rate-limited the status check; checking again in ${intervalMs / 1000} seconds.`
        )
      );
    }
    await sleep(Math.min(intervalMs, deadline - Date.now()));
  }
}

function identifyCreatedDeployment(deployments: z.infer<typeof deploymentListSchema>, upStartedAt: number): string {
  const candidates = deployments.filter(({ createdAt }) => Date.parse(createdAt) >= upStartedAt);
  const [candidate] = candidates;
  if (candidates.length !== 1 || !candidate) {
    exitWithError(
      `Expected one Railway deployment created since railway up started, but found ${candidates.length}${candidates.length > 0 ? ` (${candidates.map(({ id }) => id).join(', ')})` : ''}; check the service on Railway before deploying again.`
    );
  }
  return candidate.id;
}

/** Print the build logs of the deployment; a failure only warns, since the verdict comes from the status. */
async function printBuildLogs(
  context: RailwayContext,
  envName: string,
  targetArgs: string[],
  deploymentId: string
): Promise<void> {
  const args = ['logs', deploymentId, '--build', '--json', '--lines=5000', ...targetArgs];
  const ret = await spawnRailway(context, args, envName, 'pipe', CALL_TIMEOUT_MS);
  if (ret.status !== 0) {
    console.warn(
      chalk.yellow(
        `railway logs failed (${ret.status === null ? 'timed out' : `exit ${ret.status}`}); build logs are unavailable.`
      )
    );
    return;
  }
  for (const line of ret.stdout.split('\n')) {
    const logLine = logLineSchema.safeParse(parseJson(line));
    if (logLine.success) console.info(logLine.data.message.trimEnd());
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * List the newest deployments of the target service, or no deployments after a warning: a transient API
 * error or malformed output must not fail the deploy, so the callers check again.
 */
async function listDeployments(
  context: RailwayContext,
  envName: string,
  targetArgs: string[],
  callTimeoutMs: number
): Promise<{ deployments?: z.infer<typeof deploymentListSchema>; rateLimited: boolean }> {
  const ret = await spawnRailway(
    context,
    ['deployment', 'list', '--json', '--limit=20', ...targetArgs],
    envName,
    'pipe',
    callTimeoutMs
  );
  if (ret.status === 0) {
    try {
      return { deployments: deploymentListSchema.parse(JSON.parse(ret.stdout)), rateLimited: false };
    } catch (error) {
      console.warn(chalk.yellow(`railway deployment list printed unexpected output: ${String(error)}`));
    }
  } else if (ret.status === null) {
    console.warn(chalk.yellow(`railway deployment list did not answer within ${callTimeoutMs / 1000} seconds.`));
  } else {
    console.warn(chalk.yellow(`railway deployment list failed (exit ${ret.status}): ${ret.stderr.trim()}`));
    return { rateLimited: RATE_LIMIT_PATTERN.test(`${ret.stdout}${ret.stderr}`) };
  }
  return { rateLimited: false };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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
  const output = await runRailway(context, ['config', 'plan', '--json', '--out', planPath], envName);
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

async function runRailway(context: RailwayContext, args: string[], envName: string): Promise<string> {
  const ret = await spawnRailway(context, args, envName, 'pipe');
  if (ret.status !== 0) {
    console.error(ret.stdout.trim());
    console.error(ret.stderr.trim());
    exitWithRailwayError(args, ret.status);
  }
  return ret.stdout;
}

function exitWithRailwayError(args: string[], status: number | null): never {
  exitWithError(`railway ${args.slice(0, 2).join(' ')} failed (exit ${status}).`);
}

async function spawnRailway(
  context: RailwayContext,
  args: string[],
  envName: string,
  stdio: 'pipe' | 'tee',
  timeoutMs?: number
): Promise<Awaited<ReturnType<typeof spawnAsync>>> {
  return spawnAsync(context.binaryPath, args, {
    cwd: context.project.dirPath,
    env: await buildRailwayEnv(context, envName),
    stdio: 'pipe',
    printingStdout: stdio === 'tee',
    printingStderr: stdio === 'tee',
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
