import fs from 'node:fs';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { execute } from '@yarnpkg/shell';
import chalk from 'chalk';

import { promisePool } from '../promisePool.js';

interface Options {
  exitIfFailed?: boolean;
  timeout?: number;
}

const defaultOptions: Options = {
  exitIfFailed: true,
};

export async function runWithYarn(script: string, opts: Omit<Options, 'timeout'> = defaultOptions): Promise<number> {
  const normalizedScript = normalizeScript(script);
  const exitCode = await execute(normalizedScript, undefined);
  finishedScript(normalizedScript, exitCode, opts);
  return exitCode;
}

export async function runWithSpawn(script: string, opts: Options = defaultOptions): Promise<number> {
  const normalizedScript = normalizeScript(script);
  const ret = await spawnAsync(normalizedScript, undefined, {
    shell: true,
    stdio: 'inherit',
    timeout: opts?.timeout,
    killOnExit: true,
    verbose: true,
  });
  finishedScript(normalizedScript, ret.status, opts);
  return ret.status ?? 1;
}

export function runWithSpawnInParallel(script: string, opts: Options = defaultOptions): Promise<void> {
  return promisePool.run(async () => {
    const normalizedScript = normalizeScript(script, true);
    const ret = await spawnAsync(normalizedScript, undefined, {
      shell: true,
      stdio: 'pipe',
      timeout: opts?.timeout,
      mergeOutAndError: true,
      killOnExit: true,
      verbose: true,
    });
    printStart(normalizedScript);
    const out = ret.stdout.trim();
    if (out) console.info(out);
    finishedScript(normalizedScript, ret.status, opts);
  });
}

function normalizeScript(script: string, silent = false): string {
  // TODO: consider Yarn PnP
  addBinPathsToEnv();

  const newScript = script.replaceAll('\n', '').replaceAll(/\s\s+/g, ' ').trim();
  !silent && printStart(newScript);
  return newScript;
}

function printStart(normalizedScript: string): void {
  console.info('\n' + chalk.green(chalk.bold('Start:'), normalizedScript));
}

function finishedScript(script: string, exitCode: number | null, opts?: Omit<Options, 'timeout'>): void {
  if (exitCode === 0) {
    console.info(chalk.cyan(chalk.bold('Finished:'), script));
  } else {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}): `), script));
    if (opts?.exitIfFailed) {
      process.exit(exitCode ?? 1);
    }
  }
}

let addedBinPaths = false;

function addBinPathsToEnv(): void {
  if (addedBinPaths) return;
  addedBinPaths = true;

  let currentPath = path.resolve();
  for (;;) {
    const binPath = path.join(currentPath, 'node_modules', '.bin');
    if (fs.existsSync(binPath)) {
      process.env.PATH += `:${binPath}`;
    }

    const parentPath = path.dirname(currentPath);
    if (currentPath === parentPath) {
      break;
    }
    currentPath = parentPath;
  }
}
