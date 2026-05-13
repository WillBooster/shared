import fs from 'node:fs';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findRootAndSelfProjects } from '../project.js';
import { configureEnv } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { packageManager } from '../utils/runtime.js';

import { lint, type LintCommandArgv } from './lint.js';
import { test, type TestCommandArgv } from './test.js';

const builder = {
  full: {
    type: 'boolean',
    default: false,
    describe: 'Run tests after verifying project code',
  },
} as const;

type VerifyCodeCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type VerifyCodeCommandArgv = ArgumentsCamelCase<VerifyCodeCommandOptions>;

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

    await (argv.full ? verifyCodeFully(projects.self, argv) : verifyCode(projects.self, argv));
  },
};

async function verifyCodeFully(project: Project, argv: VerifyCodeCommandArgv): Promise<void> {
  const reporter = startVerifyFullReporter(project);
  try {
    await verifyCode(project, argv);
    await runProjectTest(project, argv);
    reporter.succeed();
  } catch (error) {
    reporter.fail(error);
    throw error;
  } finally {
    reporter.finish();
  }
}

async function verifyCode(project: Project, argv: VerifyCodeCommandArgv): Promise<void> {
  await runPackageCommand(`${packageManager} install`, project, argv);
  if (project.packageJson.scripts?.['gen-code']) {
    await runPackageCommand(`${packageManager} gen-code`, project, argv);
  }
  await runInProcessCommand(
    'cleanup',
    () =>
      lint({
        ...argv,
        _: ['lint'],
        fix: true,
        format: true,
        printAllOutput: true,
        quiet: true,
        silent: true,
      } as unknown as LintCommandArgv),
    { silent: true }
  );
}

async function runProjectTest(project: Project, argv: VerifyCodeCommandArgv): Promise<void> {
  const testArgv = { ...argv, _: ['test'], e2e: 'headless', silent: true } as unknown as TestCommandArgv;
  const exitCode = await test(testArgv, { exitIfFailed: false });
  if (exitCode === 0) return;

  if (!project.packageJson.scripts?.['db-reset']) {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}):`), 'test'));
    process.exit(exitCode);
  }

  console.info(
    chalk.yellow('Tests failed. This project defines "db-reset", so wb will reset the database once and retry tests.')
  );
  await runPackageCommand(`${packageManager} db-reset`, project, argv, { printRawOutput: true });

  const retryExitCode = await test(testArgv, { exitIfFailed: false });
  if (retryExitCode !== 0) {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${retryExitCode}):`), 'test after db-reset retry'));
    process.exit(retryExitCode);
  }
  console.info(chalk.green('Tests passed after db-reset retry.'));
}

async function runInProcessCommand(
  commandName: string,
  command: () => Promise<number | undefined>,
  options: { allowFailure?: boolean; silent?: boolean } = {}
): Promise<number> {
  if (!options.silent) {
    console.info('\n' + chalk.cyan(chalk.bold('Start:'), commandName));
  }
  const exitCode = (await command()) ?? 0;
  if (exitCode === 0 || options.allowFailure) {
    if (!options.silent) {
      console.info(chalk.green(chalk.bold('Finished:'), commandName));
    }
  } else {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}):`), commandName));
    process.exit(exitCode);
  }
  return exitCode;
}

async function runPackageCommand(
  command: string,
  project: Project,
  argv: VerifyCodeCommandArgv,
  options: { allowFailure?: boolean; printRawOutput?: boolean } = {}
): Promise<number> {
  printCommand(command, project.dirPath);
  if (argv.dryRun) {
    return 0;
  }

  const ret = await spawnAsync(command, undefined, {
    cwd: project.dirPath,
    env: configureEnv(project.env, { forceColor: false }),
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
  if (exitCode === 0 && (command === `${packageManager} install` || command === `${packageManager} gen-code`)) {
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

  process.stdout.write = teeWrite(process.stdout.fd, logFile) as typeof process.stdout.write;
  process.stderr.write = teeWrite(process.stderr.fd, logFile) as typeof process.stderr.write;
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

function teeWrite(outputFile: number, logFile: number): typeof process.stdout.write {
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
    fs.writeSync(outputFile, buffer);
    if (typeof encodingOrCallback === 'function') {
      encodingOrCallback();
    }
    callback?.();
    return true;
  }) as typeof process.stdout.write;
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
