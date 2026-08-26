import fs from 'node:fs';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import fg from 'fast-glob';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects, findRootAndSelfProjects, findSelfProject } from '../project.js';
import { configureEnv } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { normalizeBunLockfile } from '../utils/bunLockfile.js';

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
    if (argv.full) {
      await verifyCodeFully(projects.self, argv, steps);
    } else {
      await verifyCode(projects.self, argv, steps);
      printVerifySummary(steps, Boolean(argv.dryRun));
    }
  },
};

async function verifyCodeFully(project: Project, argv: VerifyCodeCommandArgv, steps: VerifyStep[]): Promise<void> {
  const reporter = startVerifyFullReporter(project);
  try {
    await verifyCode(project, argv, steps);
    await checkSlidevDecks(project, argv, steps);
    await runStep(steps, { name: 'test' }, () => runProjectTest(project, argv));
    // Printed before the reporter finishes so the summary lands in verify-full.log too.
    printVerifySummary(steps, Boolean(argv.dryRun));
    reporter.succeed();
  } catch (error) {
    reporter.fail(error);
    throw error;
  } finally {
    reporter.finish();
  }
}

async function verifyCode(project: Project, argv: VerifyCodeCommandArgv, steps: VerifyStep[]): Promise<void> {
  const installCommand = `${project.packageManagerCommand} install`;
  // `allowFailure` so a failed install still reaches the normalization below: bun rewrites the
  // lockfile before running lifecycle scripts, so a script failure would otherwise leave Guard
  // URLs in the working tree. The failure is reported and exits exactly as runPackageCommand would.
  const installExitCode = await runStep(steps, { detail: installCommand, name: 'install' }, () =>
    runPackageCommand(installCommand, project, argv, { allowFailure: true })
  );
  // The repository may have no `gen-code` script (where the same normalization runs at postinstall),
  // and `verify` is the command a developer runs before committing.
  if (!argv.dryRun) {
    normalizeBunLockfile(project.rootDirPath);
  }
  if (installExitCode !== 0) {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${installExitCode}):`), installCommand));
    process.exit(installExitCode);
  }
  if (project.packageJson.scripts?.['gen-code']) {
    const genCodeCommand = `${project.packageManagerCommand} gen-code`;
    await runStep(steps, { detail: genCodeCommand, name: 'gen-code' }, () =>
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
  await runStep(steps, { detail: stepDetails.cleanup, name: 'cleanup' }, () =>
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
  await runStep(steps, { detail: stepDetails.typecheck, name: 'typecheck' }, () =>
    runInProcessCommand('typecheck', () => typeCheck({ ...argv, _: ['typecheck'] } as unknown as TypeCheckCommandArgv))
  );
}

/**
 * Audits every Slidev deck in the repository with slidev-check.
 *
 * A deck whose content overflows its slide still type-checks, lints, and tests clean, so rendering
 * the decks is the only signal that catches it. wbfy installs slidev-check wherever a `*.slidev.md`
 * deck exists, so the checker is always available here.
 */
async function checkSlidevDecks(project: Project, argv: VerifyCodeCommandArgv, steps: VerifyStep[]): Promise<void> {
  const deckPaths = fg
    .globSync('**/*.slidev.md', { cwd: project.dirPath, ignore: ['**/node_modules/**'] })
    .toSorted((a, b) => a.localeCompare(b));
  if (deckPaths.length === 0) return;

  await runStep(steps, { detail: deckPaths.join(' '), name: 'slidev-check' }, async () => {
    for (const deckPath of deckPaths) {
      await runPackageCommand(`${project.packageManagerRunCommand} slidev-check '${deckPath}'`, project, argv);
    }
  });
}

async function runProjectTest(project: Project, argv: VerifyCodeCommandArgv): Promise<void> {
  const testArgv = withDefaultTestCascadeEnv({
    ...argv,
    _: ['test'],
    e2e: 'headless',
    silent: true,
  } as unknown as TestCommandArgv);
  const exitCode = await test(testArgv, { exitIfFailed: false });
  if (exitCode === 0) return;

  if (!project.packageJson.scripts?.['db-reset']) {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}):`), 'test'));
    process.exit(exitCode);
  }

  console.info(
    chalk.yellow('Tests failed. This project defines "db-reset", so wb will reset the database once and retry tests.')
  );
  await runPackageCommand(`${project.packageManagerCommand} db-reset`, findTestProject(project, testArgv), testArgv, {
    printRawOutput: true,
  });

  const retryExitCode = await test(testArgv, { exitIfFailed: false });
  if (retryExitCode !== 0) {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${retryExitCode}):`), 'test after db-reset retry'));
    process.exit(retryExitCode);
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

/** Times a step and records it for the final summary. Steps that fail exit the process instead. */
async function runStep<T>(
  steps: VerifyStep[],
  step: Omit<VerifyStep, 'durationMs'>,
  run: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  const result = await run();
  steps.push({ ...step, durationMs: Date.now() - startedAt });
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
    process.exit(exitCode);
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
  options: { allowFailure?: boolean; printRawOutput?: boolean } = {}
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
    printingStdout: options.printRawOutput,
    printingStderr: options.printRawOutput,
    verbose: argv.verbose,
  });
  const exitCode = ret.status ?? 1;
  if (!options.printRawOutput) {
    printPackageCommandOutput(command, exitCode, ret.stdout);
  }

  if (exitCode !== 0 && !options.allowFailure) {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}):`), command));
    process.exit(exitCode);
  }
  return exitCode;
}

/**
 * Prints package command output for `wb verify`.
 *
 * `wb verify` is primarily consumed by AI coding agents, so successful noisy
 * commands are summarized while failure output remains available for diagnosis.
 *
 * @param command The executed command.
 * @param exitCode The command exit code.
 * @param output The merged stdout and stderr output from the command.
 */
function printPackageCommandOutput(command: string, exitCode: number, output: string): void {
  if (exitCode === 0 && /^(?:bun|yarn) (?:install|gen-code)$/u.test(command)) {
    console.info(chalk.green('Succeeded.'));
    return;
  }

  const trimmedOutput = output.trim();
  if (trimmedOutput) {
    process.stdout.write(trimmedOutput);
    process.stdout.write('\n');
  }
}

function printCommand(command: string, cwd: string): void {
  console.info('\n' + chalk.cyan(chalk.bold('Command:'), command) + chalk.gray(` at ${cwd}`));
}

function startVerifyFullReporter(project: Project): {
  fail: (error?: unknown) => void;
  finish: () => void;
  succeed: () => void;
} {
  const startedAt = Date.now();
  const wbDirPath = path.join(project.dirPath, '.wb');
  fs.mkdirSync(wbDirPath, { recursive: true });

  const logFilePath = path.join(wbDirPath, 'verify-full.log');
  const logFile = fs.openSync(logFilePath, 'w');
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let succeeded = false;
  let finished = false;

  process.stdout.write = teeWrite(originalStdoutWrite, logFile) as typeof process.stdout.write;
  process.stderr.write = teeWrite(originalStderrWrite, logFile) as typeof process.stderr.write;
  console.info(chalk.cyan(chalk.bold('Full log:'), logFilePath));

  const finish = (): void => {
    if (finished) return;
    finished = true;

    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;

    const elapsedTime = formatElapsedTime(Date.now() - startedAt);
    const status = succeeded ? 'Succeeded' : 'Failed';
    const summary = `${status} in ${elapsedTime}. Full log: ${logFilePath}\n`;
    const coloredSummary = succeeded ? chalk.green(summary) : chalk.red(summary);
    originalStdoutWrite(coloredSummary);
    fs.writeSync(logFile, summary);
    fs.closeSync(logFile);
  };

  process.once('exit', finish);

  return {
    fail: (error) => {
      succeeded = false;
      if (error) {
        console.error(error);
      }
    },
    finish: () => {
      process.removeListener('exit', finish);
      finish();
    },
    succeed: () => {
      succeeded = true;
    },
  };
}

function teeWrite(originalWrite: typeof process.stdout.write, logFile: number): typeof process.stdout.write {
  return ((
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ) => {
    const buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8')
        : chunk;
    fs.writeSync(logFile, buffer);
    // Write to the terminal via the original stream method: a synchronous fs.writeSync on the
    // stdout/stderr fd throws EAGAIN on CI's non-blocking pipes when large output flushes at once,
    // while the stream method buffers internally and handles backpressure.
    return originalWrite(buffer, typeof encodingOrCallback === 'function' ? encodingOrCallback : callback);
  }) as typeof process.stdout.write;
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
