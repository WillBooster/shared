import type { SpawnAsyncOptions, SpawnAsyncReturns } from '@willbooster/shared-lib-node/src';
import { spawnAsync } from '@willbooster/shared-lib-node/src';

export async function spawnAndReturnStatus(command: string, args: string[], cwd: string, retry = 0): Promise<number> {
  for (;;) {
    console.log(`$ ${command} ${args.join(' ')} at ${cwd}`);
    const result = await spawnOrUndefined(command, args, { cwd, env: getSpawnEnv(), stdio: 'inherit' });
    const status = result?.status ?? 1;
    if (status === 0 || retry-- <= 0) return status;
  }
}

export async function spawnAndReturnStdout(command: string, args: string[], cwd: string): Promise<string> {
  const quotedArgs = args.map((s) => `"${s}"`).join(', ');
  const result = await spawnOrUndefined(command, args, { cwd, env: getSpawnEnv() }, (error) => {
    console.error(`${command} [${quotedArgs}] failed with: ${error.message}`);
  });
  const error = result?.stderr.trim();
  if (error) {
    console.error(`${command} [${quotedArgs}] outputs the following content to stderr:\n${error}`);
  }
  return result?.stdout.trim() ?? '';
}

/** Resolves to undefined when the command cannot be spawned (e.g. it is not installed). */
export async function spawnOrUndefined(
  command: string,
  args: string[],
  options: SpawnAsyncOptions,
  onSpawnError?: (error: Error) => void
): Promise<SpawnAsyncReturns | undefined> {
  try {
    return await spawnAsync(command, args, options);
  } catch (error) {
    onSpawnError?.(error as Error);
    return undefined;
  }
}

function getSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.PATH && env.BERRY_BIN_FOLDER) {
    env.PATH = env.PATH.split(':')
      .filter((p) => p !== env.BERRY_BIN_FOLDER)
      .join(':');
  }
  return env;
}
