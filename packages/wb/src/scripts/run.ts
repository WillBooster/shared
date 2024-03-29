import { spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { ArgumentsCamelCase, InferredOptionTypes } from 'yargs';

import { killPortProcessImmediatelyAndOnExit } from '../processUtils.js';
import type { Project } from '../project.js';
import { promisePool } from '../promisePool.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

interface Options {
  exitIfFailed?: boolean;
  timeout?: number;
}

const defaultOptions: Options = {
  exitIfFailed: true,
};

export async function runWithSpawn(
  script: string,
  project: Project,
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof sharedOptionsBuilder>>>,
  opts: Options = defaultOptions
): Promise<number> {
  const [printableScript, runnableScript] = normalizeScript(script, project);
  printStart(printableScript, project);
  if (argv.verbose) {
    printStart(runnableScript, project, 'Start (raw)', true);
  }
  if (argv.dryRun) {
    printFinishedAndExitIfNeeded(printableScript, 0, opts);
    return 0;
  }

  const port = runnableScript.match(/http:\/\/127.0.0.1:(\d+)/)?.[1];
  if (runnableScript.includes('wait-on') && port && !runnableScript.includes('docker run')) {
    await killPortProcessImmediatelyAndOnExit(Number(port));
  }
  const ret = await spawnAsync(runnableScript, undefined, {
    cwd: project.dirPath,
    env: project.env,
    shell: true,
    stdio: 'inherit',
    timeout: opts?.timeout,
    killOnExit: true,
    verbose: argv.verbose,
  });
  printFinishedAndExitIfNeeded(printableScript, ret.status, opts);
  return ret.status ?? 1;
}

export function runWithSpawnInParallel(
  script: string,
  project: Project,
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof sharedOptionsBuilder>>>,
  opts: Options = defaultOptions
): Promise<void> {
  return promisePool.run(async () => {
    const [printableScript, runnableScript] = normalizeScript(script, project);
    printStart(printableScript, project, 'Start (parallel)', true);
    if (argv.dryRun) {
      printStart(printableScript, project, 'Started (log)');
      if (argv.verbose) {
        printStart(runnableScript, project, 'Started (raw)', true);
      }
      printFinishedAndExitIfNeeded(printableScript, 0, opts);
      return;
    }

    const ret = await spawnAsync(runnableScript, undefined, {
      cwd: project.dirPath,
      env: project.env,
      shell: true,
      stdio: 'pipe',
      timeout: opts?.timeout,
      mergeOutAndError: true,
      killOnExit: true,
      verbose: argv.verbose,
    });
    printStart(printableScript, project, 'Started (log)');
    if (argv.verbose) {
      printStart(runnableScript, project, 'Started (raw)', true);
    }
    const out = ret.stdout.trim();
    if (out) console.info(out);
    printFinishedAndExitIfNeeded(printableScript, ret.status, opts);
  });
}

function normalizeScript(script: string, project: Project): [string, string] {
  const newScript = script
    .replaceAll('\n', '')
    .replaceAll(/\s\s+/g, ' ')
    .replaceAll('PRISMA ', project.packageJson.dependencies?.['blitz'] ? 'YARN blitz prisma ' : 'YARN prisma ')
    .trim();
  return [newScript.replaceAll('YARN ', 'yarn '), newScript.replaceAll('YARN ', project.binExists ? '' : 'yarn ')];
}

export function printStart(normalizedScript: string, project: Project, prefix = 'Start', weak = false): void {
  console.info(
    '\n' +
      (weak ? chalk.gray : chalk.cyan)(chalk.bold(`${prefix}:`), normalizedScript) +
      chalk.gray(` at ${project.dirPath}`)
  );
}

export function printFinishedAndExitIfNeeded(
  script: string,
  exitCode: number | null,
  opts: Omit<Options, 'timeout'>
): void {
  if (exitCode === 0) {
    console.info(chalk.green(chalk.bold('Finished:'), script));
  } else {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}): `), script));
    if (opts.exitIfFailed !== false) {
      process.exit(exitCode ?? 1);
    }
  }
}
