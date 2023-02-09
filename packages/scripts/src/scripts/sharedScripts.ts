import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { execute } from '@yarnpkg/shell';

export async function runWithYarn(script: string, exitWithNonZeroCode = true): Promise<number> {
  const exitCode = await execute(normalizeScript(script), undefined);
  if (exitWithNonZeroCode && exitCode !== 0) {
    process.exit(exitCode);
  }
  return exitCode;
}

export async function runWithSpawn(script: string, timeout?: number, exitWithNonZeroCode = true): Promise<void> {
  const ret = await spawnAsync(normalizeScript(script), undefined, { shell: true, stdio: 'inherit', timeout });
  if (exitWithNonZeroCode && ret.status !== 0) {
    process.exit(ret.status ?? 1);
  }
}

function normalizeScript(script: string): string {
  const newScript = script.replaceAll('\n', '').replaceAll(/\s\s+/g, ' ').trim();
  console.info(`$ ${newScript}`);
  return newScript;
}
