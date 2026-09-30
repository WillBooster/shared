import childProcess from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

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

const deploymentListSchema = z.array(z.object({ id: z.string(), status: z.string() }));

const buildLogEntrySchema = z.object({ timestamp: z.string(), message: z.string() });

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
// Bound each deployment list and log fetch, so a stalled one cannot hang the deploy. A deployment list is
// further capped by the remaining wait deadline, but never below the short timeout after `railway up`, so
// the verdict gets a check even when `railway up` used up the time; one around `config apply` is kept short
// so that a stalled one leaves the 60-second wait time for more polls.
const CALL_TIMEOUT_MS = 60_000;
const SHORT_CALL_TIMEOUT_MS = 15_000;
// `railway up --ci` prints the build logs URL, whose `id` parameter is the created deployment's ID, before
// streaming the build logs.
const BUILD_LOGS_URL_PATTERN = /Build Logs: \S*[?&]id=([\w-]+)/;
// `railway up --ci` prints this when its log or status stream fails, then polls the status every 5 seconds
// until the deployment finishes; wb's own checks are far less frequent, so it stops the CLI instead.
const CLI_STATUS_POLLING_MESSAGE = 'Waiting on the deployment status instead';
// Build log timestamps are not monotonic because build steps run in parallel, so a backfill starts this much
// before the newest line already seen and skips the lines seen before.
const BACKFILL_OVERLAP_MS = 60_000;
// Railway occasionally rejects a fresh plan with this message although nothing changed the environment
// since the plan, apparently from a stale read on its side; a rejected apply changes nothing.
const STALE_PLAN_MESSAGE = 'The environment changed since this plan was computed';
const MAX_APPLY_ATTEMPTS = 3;
const STALE_PLAN_RETRY_DELAY_MS = 5000;
const deployTimeoutSecondsSchema = z.coerce.number().positive().default(1800);

interface RailwayUpResult {
  deploymentId?: string;
  exitDescription: string;
  startedAt: number;
  /** How many times `railway up` printed each line, as `toDisplayLine` normalizes it. */
  printedLineCounts: Map<string, number>;
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
 * and re-checking when Railway rejects the plan as stale) and wait up to 60 seconds for a deployment of the service it triggers (an apply that changes only other
 * services or ownership metadata may trigger none), then `railway up`, printing its build logs
 * live, and wait until the created deployment succeeds. With `--dry-run`, only check the plan of every environment in
 * `railwayTarget.services`, never changing Railway.
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
  if (!up.deploymentId) {
    exitWithError(
      `railway up ended (${up.exitDescription}) without printing the created deployment's ID; check the service on Railway before deploying again.`
    );
  }
  const { deploymentId } = up;
  const failure = await waitForDeployment(context, envName, targetArgs, up, deploymentId, deadline, timeoutSeconds);
  if (failure) {
    await printDeploymentLogs(context, envName, [deploymentId, '--deployment', '--lines=200', ...targetArgs]);
    exitWithError(failure);
  }
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
 * Run `railway up --ci`, printing its output as it arrives. Its exit code and output never decide the
 * deploy: the CLI may exit before the deployment finishes, e.g. when its log stream breaks, so the caller
 * checks the created deployment's status. It is stopped at `deadline`, and as soon as it falls back to
 * frequent status polling.
 */
async function runRailwayUp(
  context: RailwayContext,
  envName: string,
  targetArgs: string[],
  deadline: number
): Promise<RailwayUpResult> {
  const startedAt = Date.now();
  const proc = childProcess.spawn(context.binaryPath, ['up', '--ci', ...targetArgs], {
    cwd: context.project.dirPath,
    env: await buildRailwayEnv(context, envName),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stoppedReason: string | undefined;
  const stop = (reason: string): void => {
    stoppedReason ??= reason;
    proc.kill();
  };
  const stopOnExit = (): void => {
    proc.kill();
  };
  process.once('exit', stopOnExit);
  const timer = setTimeout(() => {
    stop('stopped at the deploy timeout');
  }, deadline - startedAt);
  const result: RailwayUpResult = { exitDescription: '', startedAt, printedLineCounts: new Map() };
  const handleLine = (line: string): void => {
    result.deploymentId ??= BUILD_LOGS_URL_PATTERN.exec(line)?.[1];
    const displayLine = toDisplayLine(line);
    if (displayLine) {
      result.printedLineCounts.set(displayLine, (result.printedLineCounts.get(displayLine) ?? 0) + 1);
    }
    if (line.includes(CLI_STATUS_POLLING_MESSAGE)) stop('stopped by wb, which checks the status itself');
  };
  for (const [input, output] of [
    [proc.stdout, process.stdout],
    [proc.stderr, process.stderr],
  ] as const) {
    const lines = readline.createInterface({ input });
    lines.on('line', (line) => {
      // Stop reading while a slow consumer of wb's output catches up, instead of buffering without bound.
      if (!output.write(`${line}\n`)) {
        lines.pause();
        output.once('drain', () => {
          lines.resume();
        });
      }
      handleLine(line);
    });
  }
  let status: number | null;
  let signal: NodeJS.Signals | null;
  try {
    [status, signal] = (await once(proc, 'close')) as [number | null, NodeJS.Signals | null];
  } finally {
    clearTimeout(timer);
    process.off('exit', stopOnExit);
  }
  result.exitDescription = stoppedReason ?? (status === null ? `signal ${signal}` : `exit ${status}`);
  return result;
}

/**
 * Check the status of the deployment `railway up` created until it is terminal; return why it failed, if
 * it did. `railway up` usually ends when the deployment finishes, so one check suffices; otherwise the
 * checks are infrequent, and each one that is not rate-limited prints the build logs `railway up` missed.
 * The first check always gets a short call time, even when `railway up` used up the time. A check that
 * Railway rate-limits proves nothing, so it backs off and, past `deadline`, keeps the wait going for at
 * most another timeout. While the status is unknown, nothing waited on runs past the deadline in force,
 * and a backfill never takes the time the last check needs; once the status is terminal, the build log
 * backfill only explains the verdict and has just its own call timeout.
 */
async function waitForDeployment(
  context: RailwayContext,
  envName: string,
  targetArgs: string[],
  up: RailwayUpResult,
  deploymentId: string,
  deadline: number,
  timeoutSeconds: number
): Promise<string | undefined> {
  const printMissedBuildLogs = createBuildLogBackfill(context, envName, targetArgs, deploymentId, up);
  const rateLimitedDeadline = deadline + timeoutSeconds * 1000;
  let waitDeadline = Math.max(deadline, Date.now() + SHORT_CALL_TIMEOUT_MS);
  let intervalMs = STATUS_CHECK_INTERVAL_MS;
  let lastStatus: string | undefined;
  for (let checkCount = 1; ; checkCount++) {
    const callTimeoutMs = Math.min(CALL_TIMEOUT_MS, waitDeadline - Date.now());
    const { deployments, rateLimited } = await listDeployments(context, envName, targetArgs, callTimeoutMs);
    // The list holds only the newest deployments, so absence proves nothing; removal shows as a status.
    const status = deployments?.find(({ id }) => id === deploymentId)?.status;
    if (status && status !== lastStatus) {
      lastStatus = status;
      console.info(`[${envName}] Railway deployment ${deploymentId}: ${status}`);
    }
    // `railway up` exits 0 both after the verdict and after losing its log stream, so every verdict prints
    // the build logs it missed.
    if (status && (SUCCEEDED_STATUSES.has(status) || FAILED_STATUSES.has(status))) {
      await printMissedBuildLogs(CALL_TIMEOUT_MS);
    }
    if (status && SUCCEEDED_STATUSES.has(status)) return;
    if (status && FAILED_STATUSES.has(status)) return `Railway deployment ${deploymentId} ended with ${status}.`;
    if (checkCount === 1) {
      console.info(
        `[${envName}] railway up ended (${up.exitDescription}) before wb could confirm that Railway deployment ${deploymentId} finished; checking its status again.`
      );
    }
    waitDeadline = rateLimited ? rateLimitedDeadline : deadline;
    // The last check starts early enough to finish by the deadline, so nothing else may use that time.
    const lastCheckStart = waitDeadline - SHORT_CALL_TIMEOUT_MS;
    if (Date.now() >= lastCheckStart) {
      return `Railway deployment ${deploymentId} did not finish within ${timeoutSeconds} seconds (last status: ${lastStatus ?? 'not listed'}); check it on Railway before deploying again. WB_RAILWAY_DEPLOY_TIMEOUT_SECONDS overrides the timeout.`;
    }
    if (!rateLimited) await printMissedBuildLogs(Math.min(CALL_TIMEOUT_MS, lastCheckStart - Date.now()));
    intervalMs = rateLimited ? Math.min(intervalMs * 2, MAX_STATUS_CHECK_INTERVAL_MS) : STATUS_CHECK_INTERVAL_MS;
    if (rateLimited) {
      console.warn(
        chalk.yellow(
          `[${envName}] Railway rate-limited the status check; checking again in ${intervalMs / 1000} seconds.`
        )
      );
    }
    await sleep(Math.min(intervalMs, lastCheckStart - Date.now()));
  }
}

/**
 * Return a function that prints the build log lines of the deployment that neither `railway up` nor an
 * earlier call printed. A log fetch failure only warns: the verdict comes from the status.
 */
function createBuildLogBackfill(
  context: RailwayContext,
  envName: string,
  targetArgs: string[],
  deploymentId: string,
  up: RailwayUpResult
): (timeoutMs: number) => Promise<void> {
  const seenEntries = new Set<string>();
  let newestTimestamp = up.startedAt;
  return async (timeoutMs) => {
    const since = new Date(newestTimestamp - BACKFILL_OVERLAP_MS).toISOString();
    const args = ['logs', deploymentId, '--build', '--json', `--since=${since}`, '--lines=5000', ...targetArgs];
    const ret = await spawnRailway(context, args, envName, 'pipe', timeoutMs);
    if (ret.status !== 0) {
      console.warn(
        chalk.yellow(
          `railway logs failed (${ret.status === null ? 'timed out' : `exit ${ret.status}`}); the build logs above may be incomplete.`
        )
      );
      return;
    }
    for (const jsonLine of ret.stdout.split('\n')) {
      const entry = parseBuildLogEntry(jsonLine);
      const key = entry && `${entry.timestamp} ${entry.message}`;
      if (!entry || !key || seenEntries.has(key)) continue;
      seenEntries.add(key);
      newestTimestamp = Math.max(newestTimestamp, Date.parse(entry.timestamp) || 0);
      for (const line of entry.message.split(/\r?\n|\r/)) {
        const displayLine = toDisplayLine(line);
        if (!displayLine) continue;
        const printedCount = up.printedLineCounts.get(displayLine) ?? 0;
        if (printedCount > 0) up.printedLineCounts.set(displayLine, printedCount - 1);
        else console.info(displayLine);
      }
    }
  };
}

function parseBuildLogEntry(jsonLine: string): z.infer<typeof buildLogEntrySchema> | undefined {
  try {
    return buildLogEntrySchema.parse(JSON.parse(jsonLine));
  } catch {
    return undefined;
  }
}

/** Normalize a log line so that a line `railway up` printed matches the same line fetched as JSON. */
function toDisplayLine(line: string): string {
  return stripVTControlCharacters(line).trimEnd();
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
  const ret = await spawnRailway(context, deploymentListArgs(targetArgs), envName, 'pipe', callTimeoutMs);
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

function deploymentListArgs(targetArgs: string[]): string[] {
  return ['deployment', 'list', '--json', '--limit=20', ...targetArgs];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function printDeploymentLogs(context: RailwayContext, envName: string, args: string[]): Promise<void> {
  const ret = await spawnRailway(context, ['logs', ...args], envName, 'inherit', CALL_TIMEOUT_MS);
  if (ret.status === null) {
    console.warn(chalk.yellow(`railway logs did not answer within ${CALL_TIMEOUT_MS / 1000} seconds.`));
  } else if (ret.status !== 0) {
    console.warn(chalk.yellow(`railway logs failed (exit ${ret.status}).`));
  }
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
  stdio: 'inherit' | 'pipe' | 'tee',
  timeoutMs?: number
): Promise<Awaited<ReturnType<typeof spawnAsync>>> {
  return spawnAsync(context.binaryPath, args, {
    cwd: context.project.dirPath,
    env: await buildRailwayEnv(context, envName),
    stdio: stdio === 'inherit' ? 'inherit' : 'pipe',
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
