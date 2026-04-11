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
import { typeCheck } from './typecheck.js';

const builder = {} as const;

type AiCheckCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type AiCheckCommandArgv = ArgumentsCamelCase<AiCheckCommandOptions>;

export const checkForAiCommand: CommandModule<unknown, AiCheckCommandOptions> = {
  command: ['check', 'check-for-ai'],
  describe: 'Run project checks',
  builder,
  async handler(argv) {
    const projects = findRootAndSelfProjects(argv, false);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    await checkForAi(projects.self, argv);
  },
};

export const checkAllForAiCommand: CommandModule<unknown, AiCheckCommandOptions> = {
  command: ['check-all', 'check-all-for-ai'],
  describe: 'Run project checks and tests',
  builder,
  async handler(argv) {
    const projects = findRootAndSelfProjects(argv, false);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    await checkForAi(projects.self, argv);
    await runInProcessCommand('test', async () => {
      await test({ ...argv, _: ['test'] } as TestCommandArgv);
      return;
    });
  },
};

async function checkForAi(project: Project, argv: AiCheckCommandArgv): Promise<void> {
  await runPackageCommand('install', `${packageManager} install > /dev/null`, project, argv, { silent: true });
  if (project.packageJson.scripts?.['gen-code']) {
    await runPackageCommand('gen-code', `${packageManager} gen-code > /dev/null`, project, argv, {
      silent: true,
    });
  }
  await runInProcessCommand('format', () => lint({ ...argv, _: ['lint'], format: true } as LintCommandArgv), {
    allowFailure: true,
  });
  await runInProcessCommand('typecheck', () => typeCheck(argv));
  await runInProcessCommand('lint-fix', () =>
    lint({ ...argv, _: ['lint'], fix: true, quiet: true } as LintCommandArgv)
  );
}

async function runInProcessCommand(
  commandName: string,
  command: () => Promise<number | undefined>,
  options: { allowFailure?: boolean } = {}
): Promise<number> {
  console.info(chalk.cyan(chalk.bold('Start:'), commandName));
  const exitCode = (await command()) ?? 0;
  if (exitCode === 0 || options.allowFailure) {
    console.info(chalk.green(chalk.bold('Finished:'), commandName));
  } else {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}):`), commandName));
    process.exit(exitCode);
  }
  return exitCode;
}

async function runPackageCommand(
  commandName: string,
  command: string,
  project: Project,
  argv: AiCheckCommandArgv,
  options: { allowFailure?: boolean; silent?: boolean } = {}
): Promise<number> {
  console.info(chalk.cyan(chalk.bold('Start:'), commandName) + chalk.gray(` at ${project.dirPath}`));
  if (argv.verbose) {
    console.info(chalk.gray(chalk.bold('Start (raw):'), command));
  }
  if (argv.dryRun) {
    console.info(chalk.green(chalk.bold('Finished:'), commandName));
    return 0;
  }

  const ret = await spawnAsync(command, undefined, {
    cwd: project.dirPath,
    env: configureEnv(project.env, { forceColor: true }),
    shell: true,
    stdio: options.silent ? 'ignore' : 'inherit',
    killOnExit: true,
    verbose: argv.verbose,
  });

  if (ret.status === 0 || options.allowFailure) {
    console.info(chalk.green(chalk.bold('Finished:'), commandName));
  } else {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${ret.status}):`), commandName));
    process.exit(ret.status ?? 1);
  }
  return ret.status ?? 1;
}
