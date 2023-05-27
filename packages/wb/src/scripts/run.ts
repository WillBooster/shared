import fs from 'node:fs';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { execute } from '@yarnpkg/shell';
import chalk from 'chalk';

import { project } from '../project.js';
import { promisePool } from '../promisePool.js';

interface Options {
  exitIfFailed?: boolean;
  timeout?: number;
}

const defaultOptions: Options = {
  exitIfFailed: true,
};

export async function runWithYarn(script: string, opts: Omit<Options, 'timeout'> = defaultOptions): Promise<number> {
  const [printableScript, runnableScript] = normalizeScript(script);
  printStart(printableScript);
  const exitCode = await execute(runnableScript, undefined);
  finishedScript(printableScript, exitCode, opts);
  return exitCode;
}

export async function runWithSpawn(script: string, opts: Options = defaultOptions): Promise<number> {
  const [printableScript, runnableScript] = normalizeScript(script);
  printStart(printableScript);
  const ret = await spawnAsync(runnableScript, undefined, {
    cwd: project.dirPath,
    shell: true,
    stdio: 'inherit',
    timeout: opts?.timeout,
    killOnExit: true,
    verbose: true,
  });
  finishedScript(printableScript, ret.status, opts);
  return ret.status ?? 1;
}

export function runWithSpawnInParallel(script: string, opts: Options = defaultOptions): Promise<void> {
  return promisePool.run(async () => {
    const [printableScript, runnableScript] = normalizeScript(script);
    printStart(printableScript, 'Start (parallel)', true);
    const ret = await spawnAsync(runnableScript, undefined, {
      cwd: project.dirPath,
      shell: true,
      stdio: 'pipe',
      timeout: opts?.timeout,
      mergeOutAndError: true,
      killOnExit: true,
      verbose: true,
    });
    printStart(printableScript, 'Start (log)');
    const out = ret.stdout.trim();
    if (out) console.info(out);
    finishedScript(printableScript, ret.status, opts);
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

function printStart(normalizedScript: string, prefix = 'Start', weak = false): void {
  console.info('\n' + (weak ? chalk.gray : chalk.cyan)(chalk.bold(`${prefix}:`), normalizedScript));
}

function finishedScript(script: string, exitCode: number | null, opts: Omit<Options, 'timeout'>): void {
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
