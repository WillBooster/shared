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
      lint({ ...argv, _: ['lint'], format: true, printAllOutput: true, silent: true } as unknown as LintCommandArgv),
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
        silent: true,
      } as unknown as LintCommandArgv),
    { silent: true }
  );
}

async function runProjectTest(project: Project, argv: VerifyCodeCommandArgv): Promise<void> {
  if (project.packageJson.scripts?.test?.includes('wb test')) {
    console.info('\n' + chalk.cyan(chalk.bold('Start:'), 'test'));
    await test({ ...argv, _: ['test'], e2e: 'headless' } as unknown as TestCommandArgv);
    console.info(chalk.green(chalk.bold('Finished:'), 'test'));
    return;
  }

  await runPackageCommand(`${packageManager} test`, project, argv);
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
  options: { allowFailure?: boolean } = {}
): Promise<number> {
  console.info('\n' + chalk.cyan(chalk.bold('Start:'), command) + chalk.gray(` at ${project.dirPath}`));
  if (argv.dryRun) {
    console.info(chalk.green(chalk.bold('Finished:'), command));
    return 0;
  }

  const ret = await spawnAsync(command, undefined, {
    cwd: project.dirPath,
    env: configureEnv(project.env, { forceColor: false }),
    shell: true,
    stdio: 'inherit',
    killOnExit: true,
    verbose: argv.verbose,
  });

  if (ret.status === 0 || options.allowFailure) {
    console.info(chalk.green(chalk.bold('Finished:'), command));
  } else {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${ret.status}):`), command));
    process.exit(ret.status ?? 1);
  }
  return ret.status ?? 1;
}
