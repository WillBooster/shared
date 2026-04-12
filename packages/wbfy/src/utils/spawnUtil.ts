import type { SpawnSyncOptions } from 'node:child_process';
import child_process from 'node:child_process';

export function spawnSync(command: string, args: string[], cwd: string, retry = 0): void {
  spawnSyncAndReturnStatus(command, args, cwd, retry);
}

export function spawnSyncAndReturnStatus(command: string, args: string[], cwd: string, retry = 0): number {
  let status = 1;
  do {
    const [newCmd, newArgs, options] = getSpawnSyncArgs(command, args, cwd);
    console.log(`$ ${newCmd} ${newArgs.join(' ')} at ${cwd}`);
    const ret = child_process.spawnSync(newCmd, newArgs, options);
    status = ret.status ?? 1;
    if (status === 0) break;
  } while (--retry >= 0);
  return status;
}

export function spawnSyncAndReturnStdout(command: string, args: string[], cwd: string): string {
  const [newCmd, newArgs, options] = getSpawnSyncArgs(command, args, cwd);
  options.stdio = 'pipe';
  const proc = child_process.spawnSync(newCmd, newArgs, options);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- spawnSync returns null stderr on ENOENT.
  const stderr = proc.stderr ?? '';
  const error = typeof stderr === 'string' ? stderr.trim() : stderr.toString().trim();
  if (proc.error) {
    console.error(`${newCmd} [${newArgs.map((s) => `"${s}"`).join(', ')}] failed with: ${proc.error.message}`);
  } else if (error) {
    console.error(
      `${newCmd} [${newArgs.map((s) => `"${s}"`).join(', ')}] outputs the following content to stderr:\n${error}`
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- spawnSync returns null stdout on ENOENT.
  const stdout = proc.stdout ?? '';
  return typeof stdout === 'string' ? stdout.trim() : stdout.toString().trim();
}

export function getSpawnSyncArgs(command: string, args: string[], cwd: string): [string, string[], SpawnSyncOptions] {
  const env = { ...process.env };
  // Remove berry from PATH
  if (env.PATH && env.BERRY_BIN_FOLDER) {
    env.PATH = env.PATH.replace(`${env.BERRY_BIN_FOLDER}:`, '');
  }

  return [
    command,
    args,
    {
      cwd,
      env,
      encoding: 'utf8',
      shell: false,
      stdio: 'inherit',
    },
  ];
}
