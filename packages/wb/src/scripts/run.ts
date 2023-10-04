import fs from 'node:fs';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { ArgumentsCamelCase, InferredOptionTypes } from 'yargs';

import { project } from '../project.js';
import { promisePool } from '../promisePool.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { killPortProcessImmediatelyAndOnExit } from '../utils.js';

interface Options {
  exitIfFailed?: boolean;
  timeout?: number;
}

const defaultOptions: Options = {
  exitIfFailed: true,
};

export async function runWithSpawn(
  script: string,
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof sharedOptionsBuilder>>>,
  opts: Options = defaultOptions
): Promise<number> {
  const [printableScript, runnableScript] = normalizeScript(script);
  printStart(printableScript);
  if (argv.verbose) {
    printStart(printableScript, 'Start (detailed)', true);
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
    shell: true,
    stdio: 'inherit',
    timeout: opts?.timeout,
    killOnExit: true,
    verbose: argv.verbose,
  });
  printFinishedAndExitIfNeeded(printableScript, ret.status, opts);
  return ret.status ?? 1;
}

export async function runOnEachWorkspaceIfNeeded(
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof sharedOptionsBuilder>>>
): Promise<void> {
  if (!project.packageJson.workspaces) return;

  const args = process.argv.slice(2);
  const index = args.findIndex((arg) => ['-w', '--working-dir', '--workingDir'].includes(arg));
  if (index >= 0) {
    args.splice(index, 2);
  }

  // Disable interactive mode
  process.env['CI'] = '1';
  await runWithSpawn(
    ['yarn', 'workspaces', 'foreach', '--all', '--exclude', project.name, '--verbose', 'run', 'wb', ...args].join(' '),
    argv
  );
  process.exit(0);
}

export function runWithSpawnInParallel(
  script: string,
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof sharedOptionsBuilder>>>,
  opts: Options = defaultOptions
): Promise<void> {
  return promisePool.run(async () => {
    const [printableScript, runnableScript] = normalizeScript(script);
    printStart(printableScript, 'Start (parallel)', true);
    if (argv.dryRun) {
      printStart(printableScript, 'Start (log)');
      printFinishedAndExitIfNeeded(printableScript, 0, opts);
      return;
    }

    const ret = await spawnAsync(runnableScript, undefined, {
      cwd: project.dirPath,
      shell: true,
      stdio: 'pipe',
      timeout: opts?.timeout,
      mergeOutAndError: true,
      killOnExit: true,
      verbose: argv.verbose,
    });
    printStart(printableScript, 'Start (log)');
    const out = ret.stdout.trim();
    if (out) console.info(out);
    printFinishedAndExitIfNeeded(printableScript, ret.status, opts);
  });
}

function normalizeScript(script: string): [string, string] {
  const binExists = addBinPathsToEnv();
  const newScript = script
    .replaceAll('\n', '')
    .replaceAll(/\s\s+/g, ' ')
    .replaceAll('PRISMA ', project.packageJson.dependencies?.['blitz'] ? 'YARN blitz prisma ' : 'YARN prisma ')
    .trim();
  return [newScript.replaceAll('YARN ', 'yarn '), newScript.replaceAll('YARN ', binExists ? '' : 'yarn ')];
}

export function printStart(normalizedScript: string, prefix = 'Start', weak = false): void {
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

let addedBinPaths = false;
let binFound = false;

function addBinPathsToEnv(): boolean {
  if (addedBinPaths) return binFound;
  addedBinPaths = true;

  let currentPath = project.dirPath;
  for (;;) {
    const binPath = path.join(currentPath, 'node_modules', '.bin');
    if (fs.existsSync(binPath)) {
      process.env.PATH = `${binPath}:${process.env.PATH}`;
      binFound = true;
    }

    if (fs.existsSync(path.join(currentPath, '.git'))) {
      break;
    }
    const parentPath = path.dirname(currentPath);
    if (currentPath === parentPath) {
      break;
    }
    currentPath = parentPath;
  }
  return binFound;
}
