import { execute } from '@yarnpkg/shell';

export async function runScript(script: string, verbose?: boolean, exitWithNonZeroCode = true): Promise<number> {
  script = script.replaceAll('\n', '').trim();
  if (verbose) {
    console.info(`$ ${script}`);
  }
  const exitCode = await execute(script, undefined);
  if (exitWithNonZeroCode && exitCode !== 0) {
    process.exit(exitCode);
  }
  return exitCode;
}
