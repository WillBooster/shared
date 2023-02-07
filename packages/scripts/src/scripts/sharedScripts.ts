import { execute } from '@yarnpkg/shell';

export async function runScript(script: string, exitWithNonZeroCode = true): Promise<number> {
  script = script.replaceAll('\n', '').replaceAll(/\s\s+/g, ' ').trim();
  console.info(`$ ${script}`);
  const exitCode = await execute(script, undefined);
  if (exitWithNonZeroCode && exitCode !== 0) {
    process.exit(exitCode);
  }
  return exitCode;
}
