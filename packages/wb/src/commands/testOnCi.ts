import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import { selectScripts } from '../scripts/execution/selectScripts.js';
import { normalizeScript, runWithSpawn } from '../scripts/run.js';
import { buildEnvReaderOptionArgs, type sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { PackageCommandError } from '../utils/packageCommand.js';
import { promisePool } from '../utils/promisePool.js';
import { buildShellCommand, buildShellEnvironmentAssignment } from '../utils/shell.js';
import { findTestStructureViolations, printTestStructureViolations } from '../utils/testStructure.js';

import { getDefaultUnitTargets } from './test.js';

const testOnCiBuilder = {
  'max-minutes': {
    description: 'Fail when the unit and e2e phases take longer than this many minutes in total',
    type: 'number',
    requiresArg: true,
    coerce(value: unknown): number {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error('--max-minutes takes exactly one positive number.');
      }
      return value;
    },
  },
  silent: {
    description: 'Accepted for compatibility; CI always streams complete output',
    type: 'boolean',
  },
} as const;
type CiArgv = ArgumentsCamelCase<InferredOptionTypes<typeof testOnCiBuilder & typeof sharedOptionsBuilder>>;

interface CiStep {
  project: Project;
  name: string;
  durationMs: number;
  exitCode: number;
  rerunCommand: string;
}

export const testOnCiCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof testOnCiBuilder & typeof sharedOptionsBuilder>
> = {
  command: 'test-on-ci',
  describe: 'Test project on CI.',
  builder: testOnCiBuilder,
  async handler(argv) {
    await testOnCi(argv);
  },
};

export async function testOnCi(
  argv: ArgumentsCamelCase<InferredOptionTypes<typeof testOnCiBuilder & typeof sharedOptionsBuilder>>
): Promise<void> {
  // Spawned commands re-derive their env cascade from the exported WB_ENV, so an unexported
  // WB_ENV would let a configured WB_ENV default (e.g. development) select the development
  // environment — running the destructive e2e suite against the developer's own database.
  process.env.WB_ENV ||= 'test';

  const projects = await findDescendantProjects(argv);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    process.exit(1);
  }

  const steps: CiStep[] = [];
  let interrupted = false;
  try {
    await runTests(projects.descendants, { ...argv, silent: false }, steps);
  } catch (error) {
    interrupted = true;
    if (!(error instanceof PackageCommandError)) console.error(error);
    process.exitCode = error instanceof PackageCommandError ? error.exitCode : 1;
  } finally {
    const budgetReport = argv.dryRun ? undefined : buildTimeBudgetReport(steps, argv.maxMinutes);
    if (budgetReport) process.exitCode ||= 1;
    printCiSummary(steps, argv, interrupted);
    if (budgetReport) console.info(budgetReport);
  }
}

async function runTests(projects: Project[], argv: CiArgv, steps: CiStep[]): Promise<void> {
  for (const project of projects) {
    project.env.CI ||= '1';
    // Overwrite, not ||=: project.env already carries the dotenv-derived value.
    project.env.WB_ENV = process.env.WB_ENV;

    const scripts = selectScripts(project);

    const structureViolations = findTestStructureViolations(project);
    if (structureViolations.length > 0) {
      printTestStructureViolations(project.name, structureViolations);
      steps.push(createCiStep('test layout', project, argv));
      process.exitCode = 1;
      continue;
    }

    const hasDockerfile = project.hasDockerfile;
    if (hasDockerfile) {
      await runCiStep('docker setup', () => dockerScripts.stopAll(), project, argv, steps);
    }
    const defaultUnitTargets = getDefaultUnitTargets(project);
    if (defaultUnitTargets !== false) {
      const unitArgv = { ...argv, targets: defaultUnitTargets };
      await runCiStep('unit', () => scripts.testUnit(project, unitArgv), project, argv, steps);
    }
    if (fs.existsSync(path.join(project.dirPath, 'test', 'e2e'))) {
      await runCiStep('startup', () => scripts.testStart(project, argv), project, argv, steps);
      await promisePool.promiseAll();
      if (hasDockerfile) {
        project.env.WB_DOCKER ||= '1';
        await runCiStep('docker build', () => scripts.buildDocker(project, 'test'), project, argv, steps);
      }
      await runCiStep(
        'e2e',
        () => (hasDockerfile ? scripts.testE2EDocker(project, argv, {}) : scripts.testE2EProduction(project, argv, {})),
        project,
        argv,
        steps,
        false
      );
      if (hasDockerfile) {
        await runCiStep('docker cleanup', () => dockerScripts.stop(project), project, argv, steps);
      }
    }
  }
}

async function runCiStep(
  name: string,
  buildScript: () => string | Promise<string>,
  project: Project,
  argv: CiArgv,
  steps: CiStep[],
  stopOnFailure = true
): Promise<void> {
  const step = createCiStep(name, project, argv);
  steps.push(step);
  const startedAt = Date.now();
  console.info(`\nCI phase: ${project.name} / ${name}`);
  try {
    const builtScript = await buildScript();
    const script = builtScript.replaceAll(' --allowOnly', '');
    if (argv.dryRun) {
      console.info(`Would run: ${normalizeScript(script, project).runnable}`);
      return;
    }
    step.exitCode = await runWithSpawn(script, project, argv, { exitIfFailed: false });
  } finally {
    step.durationMs = Date.now() - startedAt;
    if (!argv.dryRun) printCiStep(step);
  }
  if (step.exitCode !== 0) {
    process.exitCode = step.exitCode;
    if (stopOnFailure) throw new PackageCommandError(step.exitCode);
  }
}

function printCiSummary(steps: CiStep[], argv: CiArgv, interrupted: boolean): void {
  if (argv.dryRun) {
    console.info('\nDry run — no test commands were executed.');
    return;
  }
  console.info(`\nCI test summary: ${process.exitCode ? 'FAILED' : 'PASSED'}`);
  for (const step of steps) printCiStep(step);
  if (interrupted) console.info('Execution stopped at the failed phase.');
  for (const step of steps.filter((item) => item.exitCode !== 0)) {
    console.info(`\nFailed phase: ${step.project.name} / ${step.name}`);
    console.info(`Working directory: ${step.project.dirPath}`);
    console.info(`Rerun: ${step.rerunCommand}`);
  }
}

function buildTimeBudgetReport(steps: CiStep[], maxMinutes: number | undefined): string | undefined {
  if (maxMinutes === undefined) return;

  // The startup check and the Docker image build are excluded: shortening tests cannot reduce
  // them. The e2e phase still includes building and starting the app, which its command runs.
  const testSteps = steps.filter((step) => step.name === 'unit' || step.name === 'e2e');
  // Compare what is printed, so a reported excess is always visible in the two numbers.
  const total = formatMinutes(testSteps.reduce((sum, step) => sum + step.durationMs, 0));
  const max = formatMinutes(maxMinutes * 60_000);
  if (total.tenths <= max.tenths) return;

  const breakdown = testSteps
    .toSorted((a, b) => b.durationMs - a.durationMs)
    .map((step) => `  ${formatMinutes(step.durationMs).text.padStart(9)}  ${step.project.name} / ${step.name}`)
    .join('\n');
  return `
Test time budget exceeded: ${total.text} > ${max.text} (--max-minutes ${maxMinutes})
${breakdown}
Shorten the tests: remove redundant cases, replace fixed waits with condition waits, and share expensive setup.
Do not raise --max-minutes without the requester's approval.`;
}

function formatMinutes(durationMs: number): { tenths: number; text: string } {
  const tenths = Math.round(durationMs / 100);
  const seconds = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
  return { tenths, text: `${Math.floor(tenths / 600)}m${seconds}s` };
}

function printCiStep(step: CiStep): void {
  console.info(
    `  ${step.exitCode === 0 ? 'PASS' : 'FAIL'}  ${step.project.name} / ${step.name}  ${(step.durationMs / 1000).toFixed(1)}s  exit=${step.exitCode}`
  );
}

function createCiStep(name: string, project: Project, argv: CiArgv): CiStep {
  return {
    project,
    name,
    durationMs: 0,
    exitCode: 1,
    rerunCommand: `${buildShellEnvironmentAssignment('CI', project.env.CI!)} ${buildShellEnvironmentAssignment('WB_ENV', project.env.WB_ENV!)} ${buildShellCommand(
      [project.packageManagerCommand, 'run', 'wb', 'test-on-ci', ...buildEnvReaderOptionArgs(argv)]
    )}`,
  };
}
