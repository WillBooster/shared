import {
  spawn,
  SpawnOptions,
  SpawnOptionsWithoutStdio,
  SpawnOptionsWithStdioTuple,
  SpawnSyncReturns,
  StdioNull,
  StdioPipe,
} from 'node:child_process';

export type SpawnAsyncReturns = Omit<SpawnSyncReturns<string>, 'output' | 'error'>;

export async function spawnAsync(
  command: string,
  args?: ReadonlyArray<string>,
  options?:
    | SpawnOptionsWithoutStdio
    | SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>
    | SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioNull>
    | SpawnOptionsWithStdioTuple<StdioPipe, StdioNull, StdioPipe>
    | SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>
    | SpawnOptionsWithStdioTuple<StdioPipe, StdioNull, StdioNull>
    | SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioNull>
    | SpawnOptionsWithStdioTuple<StdioNull, StdioNull, StdioPipe>
    | SpawnOptionsWithStdioTuple<StdioNull, StdioNull, StdioNull>
    | SpawnOptions
): Promise<SpawnAsyncReturns> {
  return new Promise((resolve, reject) => {
    try {
      const proc = spawn(command, args ?? [], options ?? {});
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data;
      });
      proc.stderr?.on('data', (data) => {
        stderr += data;
      });

      proc.on('error', (error) => {
        reject(error);
      });
      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (proc.pid === undefined) {
          reject(new Error('Process has no pid.'));
        } else {
          resolve({
            pid: proc.pid,
            stdout,
            stderr,
            status: code,
            signal,
          });
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}
