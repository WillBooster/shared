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
import { testOnCi } from './testOnCi.js';

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

    await verifyCode(projects.self, argv);
    if (argv.full) {
      await runProjectTest(projects.self, argv);
    }
  },
};

async function verifyCode(project: Project, argv: VerifyCodeCommandArgv): Promise<void> {
  await runPackageCommand(`${packageManager} install`, project, argv);
  if (project.packageJson.scripts?.['gen-code']) {
    await runPackageCommand(`${packageManager} gen-code`, project, argv);
  }
  await runInProcessCommand(
    'format',
    () =>
      lint({
        ...argv,
        _: ['lint'],
        format: true,
        printAllOutput: true,
        rawOutput: true,
        silent: true,
      } as unknown as LintCommandArgv),
    {
      allowFailure: true,
      silent: true,
    }
  );
  await runInProcessCommand(
    'lint-fix',
    () =>
      lint({
        ...argv,
        _: ['lint'],
        fix: true,
        printAllOutput: true,
        quiet: true,
        rawOutput: true,
        silent: true,
      } as unknown as LintCommandArgv),
    { silent: true }
  );
}

async function runProjectTest(project: Project, argv: VerifyCodeCommandArgv): Promise<void> {
  switch (findWbTestCommand(project.packageJson.scripts?.test)) {
    case 'test': {
      console.info('\n' + chalk.cyan(chalk.bold('Start:'), 'test'));
      await test({ ...argv, _: ['test'], e2e: 'headless' } as unknown as TestCommandArgv);
      console.info(chalk.green(chalk.bold('Finished:'), 'test'));
      return;
    }
    case 'test-on-ci': {
      console.info('\n' + chalk.cyan(chalk.bold('Start:'), 'test-on-ci'));
      await testOnCi({ ...argv, _: ['test-on-ci'] } as unknown as Parameters<typeof testOnCi>[0]);
      console.info(chalk.green(chalk.bold('Finished:'), 'test-on-ci'));
      return;
    }
  }

  await runPackageCommand(`${packageManager} test`, project, argv, { printRawOutput: true });
}

function findWbTestCommand(script: string | undefined): 'test' | 'test-on-ci' | undefined {
  if (!script) return;
  const commandPrefix = String.raw`(?:^|[&(;|]\s*|\s)(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:(?:yarn|bun|pnpm)\s+(?:run\s+)?)?wb\s+`;
  if (new RegExp(`${commandPrefix}test-on-ci(?:\\s|$)`).test(script)) return 'test-on-ci';
  if (new RegExp(`${commandPrefix}test(?:\\s|$)`).test(script)) return 'test';
  return;
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

function printPackageCommandOutput(command: string, exitCode: number, output: string): void {
  if (exitCode === 0 && command === `${packageManager} install`) {
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
