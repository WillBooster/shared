import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { execute } from '@yarnpkg/shell';
import chalk from 'chalk';

interface Options {
  exitIfFailed?: boolean;
  timeout?: number;
}

export async function runWithYarn(script: string, opts?: Omit<Options, 'timeout'>): Promise<number> {
  const normalizedScript = normalizeScript(script);
  const exitCode = await execute(normalizedScript, undefined);
  finishedScript(normalizedScript, exitCode, opts);
  return exitCode;
}

export async function runWithSpawn(script: string, opts?: Options): Promise<number> {
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

function normalizeScript(script: string): string {
  const newScript = script.replaceAll('\n', '').replaceAll(/\s\s+/g, ' ').trim();
  console.info(chalk.green(chalk.bold('Start:'), newScript));
  return newScript;
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
