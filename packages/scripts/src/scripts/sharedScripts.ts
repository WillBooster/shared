import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { execute } from '@yarnpkg/shell';

export async function runWithYarn(script: string, exitWithNonZeroCode = true): Promise<number> {
  const normalizedScript = normalizeScript(script);
  const exitCode = await execute(normalizedScript, undefined);
  if (exitWithNonZeroCode && exitCode !== 0) {
    console.info(`Failed to run with exit code ${exitCode}: ${normalizedScript}`);
    process.exit(exitCode);
  }
  return exitCode;
}

export async function runWithSpawn(script: string, timeout?: number, exitWithNonZeroCode = true): Promise<void> {
  const normalizedScript = normalizeScript(script);
  const ret = await spawnAsync(normalizedScript, undefined, { shell: true, stdio: 'inherit', timeout }, true, true);
  if (exitWithNonZeroCode && ret.status !== 0) {
    console.info(`Failed to run with exit code ${ret.status}: ${normalizedScript}`);
    process.exit(ret.status ?? 1);
  }
}

function normalizeScript(script: string): string {
  const newScript = script.replaceAll('\n', '').replaceAll(/\s\s+/g, ' ').trim();
  console.info(`$ ${newScript}`);
  return newScript;
}
