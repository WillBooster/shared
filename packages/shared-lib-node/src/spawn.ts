import type {
  SpawnOptions,
  SpawnOptionsWithoutStdio,
  SpawnOptionsWithStdioTuple,
  SpawnSyncReturns,
  StdioNull,
  StdioPipe,
} from 'node:child_process';
import { spawn } from 'node:child_process';

import treeKill from 'tree-kill';

export type SpawnAsyncReturns = Omit<SpawnSyncReturns<string>, 'output' | 'error'>;

export type SpawnAsyncOptions = (
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
) & {
  input?: string;
  mergeOutAndError?: boolean;
  killOnExit?: boolean;
  verbose?: boolean;
};

export async function spawnAsync(
  command: string,
  args?: ReadonlyArray<string>,
  options?: SpawnAsyncOptions
): Promise<SpawnAsyncReturns> {
  return new Promise((resolve, reject) => {
    try {
      const proc = spawn(command, args ?? [], options ?? {});
      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');

      let stdout = '';
      let stderr = '';
      if (options?.input) {
        proc.stdin?.write(options.input);
        proc.stdin?.end();
      }
      proc.stdout?.on('data', (data) => {
        stdout += data;
      });
      proc.stderr?.on('data', (data) => {
        if (options?.mergeOutAndError) {
          stdout += data;
        } else {
          stderr += data;
        }
      });

      let stopped = false;
      const stopProcess = (): void => {
        if (stopped || !proc.pid) return;

        stopped = true;
        if (options?.verbose) {
          console.info(`treeKill(${proc.pid})`);
        }
        treeKill(proc.pid);
      };
      if (options?.killOnExit) {
        process.on('beforeExit', stopProcess);
        process.on('SIGINT', stopProcess);
      }

      proc.on('error', (error) => {
        process.removeListener('exit', stopProcess);
        proc.removeAllListeners('close');
        reject(error);
      });
      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        process.removeListener('exit', stopProcess);
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
