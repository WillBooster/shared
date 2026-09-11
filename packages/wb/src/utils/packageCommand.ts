import { spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';

import type { Project } from '../project.js';
import { configureEnv } from '../scripts/run.js';

interface PackageCommandArgv {
  dryRun?: boolean;
  verbose?: boolean;
}

export class PackageCommandError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`Package command exited with code ${exitCode}.`);
    this.exitCode = exitCode;
  }
}

export async function runPackageCommand(
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
    throw new PackageCommandError(exitCode);
  }
  return exitCode;
}

function printCommand(command: string, cwd: string): void {
  console.info('\n' + chalk.cyan(chalk.bold('Command:'), command) + chalk.gray(` at ${cwd}`));
}
