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

/**
 * Return type for spawnAsync function, based on SpawnSyncReturns but without output and error properties
 */
export type SpawnAsyncReturns = Omit<SpawnSyncReturns<string>, 'output' | 'error'>;

/**
 * Options for spawnAsync function, extending various Node.js spawn options with additional functionality
 */
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
  /** Input string to write to the spawned process's stdin */
  input?: string;
  /** If true, stderr output will be merged into stdout */
  mergeOutAndError?: boolean;
  /** If true, the spawned process will be killed when the parent process exits */
  killOnExit?: boolean;
  /** If true, enables verbose logging of process operations */
  verbose?: boolean;
  /** If true, stdout data will be printed to console as it's received */
  printingStdout?: boolean;
  /** If true, stderr data will be printed to console as it's received */
  printingStderr?: boolean;
};

/**
 * Spawns a child process asynchronously and returns a promise that resolves with the process results
 *
 * This function provides a Promise-based wrapper around Node.js's spawn function with additional features:
 * - Automatic encoding of stdout/stderr as UTF-8
 * - Option to merge stderr into stdout
 * - Option to automatically kill the process on parent exit
 * - Option to provide input via stdin
 * - Verbose logging capability
 *
 * @param command - The command to run
 * @param args - List of string arguments
 * @param options - Configuration options for the spawned process
 * @returns Promise that resolves with the process results including pid, stdout, stderr, status, and signal
 * @throws Will reject the promise if the process fails to spawn or encounters an error
 *
 * @example
 * ```typescript
 * const result = await spawnAsync('ls', ['-la'], { verbose: true });
 * console.log(result.stdout);
 * ```
 */
export async function spawnAsync(
  command: string,
  args?: readonly string[],
  options?: SpawnAsyncOptions
): Promise<SpawnAsyncReturns> {
  return new Promise((resolve, reject) => {
    try {
      const proc = spawn(command, args ?? [], options ?? {});
      // `setEncoding` is undefined in Bun
      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (data: string) => {
        stdout += data;
        if (options?.printingStdout) {
          process.stdout.write(data);
        }
      });
      proc.stderr?.on('data', (data: string) => {
        if (options?.mergeOutAndError) {
          stdout += data;
        } else {
          stderr += data;
        }
        if (options?.printingStderr) {
          process.stderr.write(data);
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
        process.removeListener('beforeExit', stopProcess);
        process.removeListener('SIGINT', stopProcess);
        proc.removeAllListeners('close');
        reject(error);
      });
      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        process.removeListener('beforeExit', stopProcess);
        process.removeListener('SIGINT', stopProcess);
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

      if (options?.input) {
        proc.stdin?.write(options.input);
        proc.stdin?.end();
      }
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(error);
    }
  });
}
