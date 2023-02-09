import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { execute } from '@yarnpkg/shell';
import chalk from 'chalk';

export async function runWithYarn(script: string, exitWithNonZeroCode = true): Promise<number> {
  const normalizedScript = normalizeScript(script);
  const exitCode = await execute(normalizedScript, undefined);
  finishedScript(normalizedScript, exitCode, exitWithNonZeroCode);
  return exitCode;
}

export async function runWithSpawn(script: string, timeout?: number, exitWithNonZeroCode = true): Promise<number> {
  const normalizedScript = normalizeScript(script);
  const ret = await spawnAsync(normalizedScript, undefined, { shell: true, stdio: 'inherit', timeout }, true, true);
  finishedScript(normalizedScript, ret.status, exitWithNonZeroCode);
  return ret.status ?? 1;
}

function normalizeScript(script: string): string {
  const newScript = script.replaceAll('\n', '').replaceAll(/\s\s+/g, ' ').trim();
  console.info(chalk.green(chalk.bold('Start:'), newScript));
  return newScript;
}

function finishedScript(script: string, exitCode: number | null, exitWithNonZeroCode: boolean): void {
  if (exitCode === 0) {
    console.info(chalk.cyan(chalk.bold('Finished:'), script));
  } else {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}): `), script));
    if (exitWithNonZeroCode) {
      process.exit(exitCode ?? 1);
    }
  }
}
