import path from 'node:path';

import { globIgnore, spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import fg from 'fast-glob';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects, findRootAndSelfProjects, findSelfProject } from '../project.js';
import { configureEnv } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { normalizeBunLockfile } from '../utils/bunLockfile.js';
import { startVerificationOutput } from '../utils/verificationOutput.js';

import { buildLintCommand, lint, type LintCommandArgv } from './lint.js';
import { test, type TestCommandArgv, withDefaultTestCascadeEnv } from './test.js';
import { buildTypeCheckCommands, typeCheck, type TypeCheckCommandArgv } from './typecheck.js';

const builder = {
  full: {
    type: 'boolean',
    default: false,
    describe: 'Run tests after verifying project code',
  },
} as const;

type VerifyCodeCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type VerifyCodeCommandArgv = ArgumentsCamelCase<VerifyCodeCommandOptions>;
type PackageCommandArgv = Pick<VerifyCodeCommandArgv, 'dryRun' | 'verbose'>;

/** A completed `wb verify` step, recorded so the final summary can prove every step actually ran. */
interface VerifyStep {
  /**
   * A short description of what the step ran, e.g. `tsc --noEmit`. Aggregated across the descendant
   * projects, so ` + ` means each tool ran somewhere, not that one command ran them all. Omitted when
   * nothing beyond the step name describes it.
   */
  detail?: string;
  durationMs: number;
  name: string;
}

interface VerificationProgress {
  steps: VerifyStep[];
  reporter?: ReturnType<typeof startVerificationOutput>;
}

class VerificationCommandError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`Verification command exited with code ${exitCode}.`);
    this.exitCode = exitCode;
  }
}

export const verifyCodeCommand: CommandModule<unknown, VerifyCodeCommandOptions> = {
  command: 'verify',
  describe: 'Verify project code',
  builder,
  async handler(argv) {
    const projects = findRootAndSelfProjects(argv, false);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const steps: VerifyStep[] = [];
    const reporter = argv.dryRun
      ? undefined
      : startVerificationOutput(path.join(projects.self.dirPath, '.wb', argv.full ? 'verify-full.log' : 'verify.log'));
    const progress = { steps, reporter };
    let exitCode = 0;
    try {
      await verifyCode(projects.self, argv, progress);
      if (argv.full) {
        await checkSlidevDecks(projects.self, argv, progress);
        await runStep(progress, { name: 'test' }, () => runProjectTest(projects.self, argv));
      }
      reporter?.succeed();
      printVerifySummary(steps, Boolean(argv.dryRun));
    } catch (error) {
      if (!(error instanceof VerificationCommandError)) console.error(error);
      exitCode = error instanceof VerificationCommandError ? error.exitCode : 1;
      process.exitCode = exitCode;
    } finally {
      await reporter?.finish(exitCode);
    }
  },
};

async function verifyCode(
  project: Project,
  argv: VerifyCodeCommandArgv,
  progress: VerificationProgress
): Promise<void> {
  const installCommand = `${project.packageManagerCommand} install`;
  // `allowFailure` so a failed install still reaches the normalization below: bun rewrites the
  // lockfile before running lifecycle scripts, so a script failure would otherwise leave Guard
  // URLs in the working tree. The failure is reported and exits exactly as runPackageCommand would.
  await runStep(progress, { detail: installCommand, name: 'install' }, async () => {
    const exitCode = await runPackageCommand(installCommand, project, argv, { allowFailure: true });
    if (!argv.dryRun) normalizeBunLockfile(project.rootDirPath);
    if (exitCode !== 0) {
      console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}):`), installCommand));
      throw new VerificationCommandError(exitCode);
    }
  });
  if (project.packageJson.scripts?.['gen-code']) {
    const genCodeCommand = `${project.packageManagerCommand} gen-code`;
    await runStep(progress, { detail: genCodeCommand, name: 'gen-code' }, () =>
      runPackageCommand(genCodeCommand, project, argv)
    );
  }
  // Resolved after `gen-code` so a generated `src` directory is already there for `hasSourceCode`,
  // which is an existsSync check, and reused by both step details below. The project factories
  // share instances per (directory, loadEnv, env-relevant argv), so `typecheck` reuses this very
  // graph while `lint` (which adds --silent) resolves its own.
  const stepDetails = await buildStepDetails(argv);
  // `lint --fix --format` prints nothing on success, so without the step summary a passing `verify`
  // looks like it never linted at all — and it silently rewrote the working tree while at it.
  await runStep(progress, { detail: stepDetails.cleanup, name: 'cleanup' }, () =>
    runInProcessCommand('cleanup', () =>
      lint({
        ...argv,
        _: ['lint'],
        fix: true,
        format: true,
        silent: true,
      } as unknown as LintCommandArgv)
    )
  );
  // Type-aware lint reports TypeScript diagnostics only for the files oxlint actually lints, and
  // the shared config ignores directories tsc still compiles (e.g. `__generated__`, `@types`,
  // `dist`). Keep the typecheck command so `verify` stays equivalent to "the repository compiles".
  // The overlap with lint is deliberate: `--type-aware` also powers type-aware lint rules, and
  // dropping only `--type-check` from lint saves ~0.1s, far less than the coverage it would cost.
  await runStep(progress, { detail: stepDetails.typecheck, name: 'typecheck' }, () =>
    runInProcessCommand('typecheck', () => typeCheck({ ...argv, _: ['typecheck'] } as unknown as TypeCheckCommandArgv))
  );
}

/**
 * Audits every Slidev deck in the repository with slidev-check.
 *
 * A deck whose content overflows its slide still type-checks, lints, and tests clean, so rendering
 * the decks is the only signal that catches it. wbfy's deck detection is recursive, so a monorepo
 * whose deck lives in a workspace gets the checker at its root too; running every deck from this
 * project's directory therefore always resolves the bin, and Slidev takes the deck's own directory
 * as its user root regardless of the working directory.
 */
async function checkSlidevDecks(
  project: Project,
  argv: VerifyCodeCommandArgv,
  progress: VerificationProgress
): Promise<void> {
  // The very glob wbfy's doesContainSlidevMd runs, so the decks audited here are exactly the ones
  // it installed the checker for: a deck under an ignored directory (a fixture deck, a built copy)
  // gets no checker and must not be audited either.
  const deckPaths = fg
    .globSync('**/*.slidev.md', { dot: true, cwd: project.dirPath, ignore: globIgnore })
    .toSorted((a, b) => a.localeCompare(b));
  if (deckPaths.length === 0) return;

  await runStep(progress, { detail: deckPaths.join(' '), name: 'slidev-check' }, async () => {
    for (const deckPath of deckPaths) {
      // Single quotes (with embedded quotes escaped) keep a deck name containing shell syntax from
      // being expanded by the shell runPackageCommand spawns.
      const quotedDeckPath = `'${deckPath.replaceAll("'", String.raw`'\''`)}'`;
      await runPackageCommand(`${project.packageManagerCommand} slidev-check ${quotedDeckPath}`, project, argv);
    }
  });
}

async function runProjectTest(project: Project, argv: VerifyCodeCommandArgv): Promise<void> {
  const testArgv = withDefaultTestCascadeEnv({
    ...argv,
    _: ['test'],
    e2e: 'headless',
    silent: false,
  } as unknown as TestCommandArgv);
  const exitCode = await test(testArgv, { exitIfFailed: false });
  if (exitCode === 0) return;

  if (!project.packageJson.scripts?.['db-reset']) {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}):`), 'test'));
    throw new VerificationCommandError(exitCode);
  }

  console.info(
    chalk.yellow('Tests failed. This project defines "db-reset", so wb will reset the database once and retry tests.')
  );
  await runPackageCommand(`${project.packageManagerCommand} db-reset`, findTestProject(project, testArgv), testArgv);

  const retryExitCode = await test(testArgv, { exitIfFailed: false });
  if (retryExitCode !== 0) {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${retryExitCode}):`), 'test after db-reset retry'));
    throw new VerificationCommandError(retryExitCode);
  }
  console.info(chalk.green('Tests passed after db-reset retry.'));
}

function findTestProject(project: Project, argv: TestCommandArgv): Project {
  const testProject = findSelfProject(argv, true, project.dirPath);
  if (!testProject) {
    throw new Error(`Project not found: ${project.dirPath}`);
  }
  return testProject;
}

/**
 * Names the tools behind the `cleanup` and `typecheck` steps.
 *
 * Both steps type-check, which reads as redundant until the recap says how they differ: `cleanup`
 * type-checks through oxlint, which sees only the files it lints (the shared config ignores
 * `__generated__`, `@types`, `dist`, ...), while `typecheck` runs the compiler over the whole
 * tsconfig program. Every label is derived from the resolved projects rather than hard-coded, so a
 * repository whose `cleanup` runs flake8 or `dart analyze` is never told it ran oxlint.
 */
async function buildStepDetails(argv: VerifyCodeCommandArgv): Promise<{ cleanup: string; typecheck?: string }> {
  const cleanup = 'lint --fix --format';
  // Deliberately resolved with no explicit dirPath, exactly as `lint` (lint.ts) and `typeCheck`
  // (typecheck.ts) resolve theirs, so the labels always describe the very project set those commands
  // process. Threading a dirPath in — the self project's, say — would let the two diverge, which is
  // the drift this function exists to prevent.
  const projects = await findDescendantProjects(argv, false);
  if (!projects) return { cleanup };

  // Asks the real builders what they would run rather than restating their conditions, so a change
  // to either command cannot leave these labels describing something it stopped doing. Only the
  // project selection is restated: `lint` and `typeCheck` apply it around their builders, not
  // inside them.
  const runsTypeAwareLint = projects.descendants.some(
    (project) =>
      project.hasOwnSourceCode && buildLintCommand(project, { fix: true, format: true })?.includes('--type-aware')
  );
  const typeCheckCommands = [
    ...new Set(projects.descendants.flatMap((project) => buildTypeCheckCommands(project).map(toDisplayCommand))),
  ];
  return {
    cleanup: runsTypeAwareLint ? `${cleanup} (oxlint --type-aware --type-check)` : cleanup,
    typecheck: typeCheckCommands.length > 0 ? typeCheckCommands.join(' + ') : undefined,
  };
}

/** Drops the package-manager placeholder `runWithSpawn` expands, leaving the tool call to show. */
function toDisplayCommand(command: string): string {
  return command.replace(/^(?:BUN|YARN) /u, '');
}

/** Times completed steps for the final summary; failed steps propagate their error. */
async function runStep<T>(
  progress: VerificationProgress,
  step: Omit<VerifyStep, 'durationMs'>,
  run: () => Promise<T>
): Promise<T> {
  progress.reporter?.startStep(step.name);
  const startedAt = Date.now();
  const result = await run();
  progress.steps.push({ ...step, durationMs: Date.now() - startedAt });
  progress.reporter?.startStep();
  return result;
}

/**
 * Runs a step that succeeds silently: the recap is the single place a successful step is announced,
 * so wrapper `Start`/`Finished` lines would only repeat it. Failures still report before exiting.
 */
async function runInProcessCommand(commandName: string, command: () => Promise<number | undefined>): Promise<number> {
  const exitCode = (await command()) ?? 0;
  if (exitCode !== 0) {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}):`), commandName));
    throw new VerificationCommandError(exitCode);
  }
  return exitCode;
}

/**
 * Recaps every completed step.
 *
 * `wb verify` is primarily consumed by AI coding agents, and its per-command output is uneven: a
 * successful `cleanup` prints nothing at all while `typecheck` prints per-package progress. Reading
 * a passing run therefore gave no evidence that linting happened, so the recap lists each step that
 * ran, what it ran, and how long it took.
 */
function printVerifySummary(steps: VerifyStep[], dryRun: boolean): void {
  if (steps.length === 0) return;

  const nameWidth = Math.max(...steps.map((step) => step.name.length));
  // `--dry-run` skips command execution, so every step took no time and verified nothing: a green
  // "Verified" recap would claim exactly the work the flag suppressed. List what would run instead.
  if (dryRun) {
    console.info('\n' + chalk.cyan(chalk.bold('Dry run — nothing was executed. Steps that would run:')));
    for (const step of steps) {
      // Pad only when a detail follows, so a detail-less step does not emit trailing whitespace.
      console.info(`  - ${step.detail ? step.name.padEnd(nameWidth) + chalk.gray(`  ${step.detail}`) : step.name}`);
    }
    return;
  }

  const durations = steps.map((step) => formatStepDuration(step.durationMs));
  const durationWidth = Math.max(...durations.map((duration) => duration.length));
  const totalDurationMs = steps.reduce((total, step) => total + step.durationMs, 0);
  console.info('\n' + chalk.green(chalk.bold(`Verified in ${formatStepDuration(totalDurationMs)}:`)));
  for (const [index, step] of steps.entries()) {
    const duration = (durations[index] as string).padStart(durationWidth);
    const detail = step.detail ? `  ${step.detail}` : '';
    console.info(chalk.green('  ✔ ') + step.name.padEnd(nameWidth) + chalk.gray(`  ${duration}${detail}`));
  }
}

async function runPackageCommand(
  command: string,
  project: Project,
  argv: PackageCommandArgv,
  options: { allowFailure?: boolean } = {}
): Promise<number> {
  printCommand(command, project.dirPath);
  if (argv.dryRun) {
    return 0;
  }

  const ret = await spawnAsync(command, undefined, {
    cwd: project.dirPath,
    env: configureEnv(project.env, { preserveColor: false }),
    shell: true,
    stdio: 'pipe',
    mergeOutAndError: true,
    killOnExit: true,
    printingStdout: true,
    printingStderr: true,
    verbose: argv.verbose,
  });
  const exitCode = ret.status ?? 1;

  if (exitCode !== 0 && !options.allowFailure) {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}):`), command));
    throw new VerificationCommandError(exitCode);
  }
  return exitCode;
}

function printCommand(command: string, cwd: string): void {
  console.info('\n' + chalk.cyan(chalk.bold('Command:'), command) + chalk.gray(` at ${cwd}`));
}

/** Sub-minute steps keep one decimal so a fast step is not flattened to a misleading `0s`. */
function formatStepDuration(milliseconds: number): string {
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(1)}s`;
  }
  return formatElapsedTime(milliseconds);
}

function formatElapsedTime(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}
