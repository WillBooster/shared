import { spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { ArgumentsCamelCase, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { killPortProcessImmediatelyAndOnExit } from '../utils/process.js';
import { promisePool } from '../utils/promisePool.js';
import { isRunningOnBun, packageManagerWithRun } from '../utils/runtime.js';

interface Options {
  ci?: boolean;
  exitIfFailed?: boolean;
  forceColor?: boolean;
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

  const port = runnableScript.match(/http-get:\/\/127.0.0.1:(\d+)/)?.[1];
  if (runnableScript.includes('wait-on') && port && !runnableScript.includes('docker run')) {
    await killPortProcessImmediatelyAndOnExit(Number(port));
  }
  const ret = await spawnAsync(runnableScript, undefined, {
    cwd: project.dirPath,
    env: configureEnv(project.env, opts),
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
): Promise<number> {
  return promisePool.runAndWaitForReturnValue(async () => {
    const [printableScript, runnableScript] = normalizeScript(script, project);
    printStart(printableScript, project, 'Start (parallel)', true);
    if (argv.dryRun) {
      printStart(printableScript, project, 'Started (log)');
      if (argv.verbose) {
        printStart(runnableScript, project, 'Started (raw)', true);
      }
      printFinishedAndExitIfNeeded(printableScript, 0, opts);
      return 0;
    }

    const ret = await spawnAsync(runnableScript, undefined, {
      cwd: project.dirPath,
      env: configureEnv(project.env, opts),
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
    if (out) {
      process.stdout.write(out);
      process.stdout.write('\n');
    }
    printFinishedAndExitIfNeeded(printableScript, ret.status, opts);
    return ret.status ?? 1;
  });
}

/**
 * Replace capitalized commands (e.g., YARN, PRISMA, BUN) with suitable commands.
 */
function normalizeScript(script: string, project: Project): [string, string] {
  let newScript = script
    .replaceAll('\n', '')
    .replaceAll(/\s\s+/g, ' ')
    .replaceAll('PRISMA ', project.packageJson.dependencies?.['blitz'] ? 'YARN blitz prisma ' : 'YARN prisma ')
    .replaceAll('BUN ', project.isBunAvailable ? 'bun --bun run ' : 'YARN ')
    // Avoid replacing `YARN run` with `run` by replacing `YARN` with `(yarn|bun --bun) run`
    .replaceAll('YARN run ', project.isBunAvailable ? 'bun --bun run ' : 'yarn run ');
  if (isRunningOnBun) {
    newScript = newScript
      .replaceAll('YARN build-ts run', 'bun --bun run')
      .replaceAll('bun --bun run bun --bun run', 'bun --bun run')
      // Because bun can run src/index.ts directly.
      .replaceAll('dist/index.js', 'src/index.ts')
      .replaceAll(/(?:YARN )?vitest run/g, 'bun test')
      // '--allowOnly' is sometimes removed.
      .replaceAll(/ --color --passWithNoTests(?: --allowOnly)?/g, '');
  }
  newScript = newScript.trim();
  return [
    fixBunCommand(newScript.replaceAll('YARN ', `${packageManagerWithRun} `)),
    fixBunCommand(
      newScript
        // Because we need to use `yarn playwright` in a project depending on `artillery-engine-playwright`.
        .replaceAll('YARN playwright ', `${packageManagerWithRun} playwright `)
        .replaceAll('YARN ', !isRunningOnBun && project.binExists ? '' : `${packageManagerWithRun} `)
    ),
  ];
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

function configureEnv(env: Record<string, string | undefined>, opts: Options): Record<string, string | undefined> {
  const newEnv = { ...env };
  if (opts.ci) {
    newEnv['CI'] = '1';
  }
  if (opts.forceColor) {
    newEnv['FORCE_COLOR'] = '3';
  }
  return newEnv;
}

function fixBunCommand(command: string): string {
  return command.includes('next dev') || command.includes('playwright') || command.includes('test/e2e-additional')
    ? command.replaceAll('bun --bun', 'bun')
    : command;
}
