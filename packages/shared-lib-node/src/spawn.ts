import type {
  ChildProcess,
  SpawnOptions,
  SpawnOptionsWithoutStdio,
  SpawnOptionsWithStdioTuple,
  SpawnSyncReturns,
  StdioNull,
  StdioPipe,
} from 'node:child_process';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

import { treeKill } from './treeKill.js';

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
  /** Whether to retain stdout/stderr in the returned result; defaults to true. */
  collectOutput?: boolean;
  /** Input string to write to the spawned process's stdin, which is closed afterwards (or at once without input) */
  input?: string;
  /** If true, stderr output will be merged into stdout */
  mergeOutAndError?: boolean;
  /** If true, the spawned process will be killed when the parent process exits */
  killOnExit?: boolean;
  /** Called with the spawned process once it has a pid, e.g. to observe its `exit` event */
  onSpawn?: (proc: ChildProcess) => void;
  /** If true, enables verbose logging of process operations */
  verbose?: boolean;
  /** If true, stdout data will be printed to console as it's received */
  printingStdout?: boolean;
  /** If true, stderr data will be printed to console as it's received */
  printingStderr?: boolean;
  /** If true, blank-only lines are skipped while printing stdout/stderr in realtime */
  omitBlankLinesWhilePrinting?: boolean;
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
    const proc = spawn(command, args ?? [], options ?? {});
    if (proc.pid) options?.onSpawn?.(proc);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stderrSink = options?.mergeOutAndError ? stdoutChunks : stderrChunks;
    const collecting = options?.collectOutput !== false;
    const omitBlankLines = options?.omitBlankLinesWhilePrinting;
    const stdoutForwarder = forwardOutput(
      proc.stdout,
      process.stdout,
      options?.printingStdout,
      omitBlankLines,
      collecting ? stdoutChunks : undefined
    );
    const stderrForwarder = forwardOutput(
      proc.stderr,
      process.stderr,
      options?.printingStderr,
      omitBlankLines,
      collecting ? stderrSink : undefined
    );
    const removeKillOnExitHandlers = options?.killOnExit ? killOnParentExit(proc, options.verbose) : () => {};
    const removeHandlers = (): void => {
      stdoutForwarder.removeDrainHandler();
      stderrForwarder.removeDrainHandler();
      removeKillOnExitHandlers();
    };

    proc.on('error', (error) => {
      removeHandlers();
      proc.removeAllListeners('close');
      reject(error);
    });
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      removeHandlers();
      stdoutForwarder.flush();
      stderrForwarder.flush();
      if (proc.pid === undefined) {
        reject(new Error('Process has no pid.'));
      } else {
        resolve({
          pid: proc.pid,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          status: code,
          signal,
        });
      }
    });

    // Like spawnSync, the child reads EOF after the input: nothing else can write to this pipe.
    if (options?.input) proc.stdin?.write(options.input);
    proc.stdin?.end();
  });
}

function forwardOutput(
  source: Readable | null,
  destination: NodeJS.WriteStream,
  printing: boolean | undefined,
  omitBlankLines: boolean | undefined,
  chunks: string[] | undefined
): { flush: () => void; removeDrainHandler: () => void } {
  const printer = createRealtimePrinter(destination, omitBlankLines);
  const resume = (): void => {
    source?.resume();
  };
  // `setEncoding` is undefined in Bun
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  source?.setEncoding?.('utf8');
  source?.on('data', (data: string) => {
    chunks?.push(data);
    if (printing && !printer.write(data)) {
      source.pause();
      destination.once('drain', resume);
    }
  });
  return {
    flush: printer.flush,
    removeDrainHandler: () => {
      destination.removeListener('drain', resume);
    },
  };
}

const cleanupSignals = ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const;

/** Returns a function that removes the handlers this registers on the parent process. */
function killOnParentExit(proc: ChildProcess, verbose: boolean | undefined): () => void {
  let stopped = false;
  const stopProcess = (): void => {
    if (stopped || !proc.pid) return;

    stopped = true;
    tryTreeKill(proc.pid, verbose);
  };
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const removeHandlers = (): void => {
    process.removeListener('beforeExit', stopProcess);
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    signalHandlers.clear();
  };
  process.on('beforeExit', stopProcess);
  for (const signal of cleanupSignals) {
    const handleSignal = (): void => {
      stopProcess();
      removeHandlers();
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    };
    signalHandlers.set(signal, handleSignal);
    process.on(signal, handleSignal);
  }
  return removeHandlers;
}

function tryTreeKill(pid: number, verbose: boolean | undefined): void {
  if (verbose) {
    console.info(`treeKill(${pid})`);
  }
  try {
    treeKill(pid);
  } catch (error) {
    if (verbose) {
      console.warn(`Failed to treeKill(${pid})`, error);
    }
  }
}

const ANSI_ESCAPE_CODE_REGEXP = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

function createRealtimePrinter(
  stream: NodeJS.WriteStream,
  omitBlankLines = false
): { write: (data: string) => boolean; flush: () => void } {
  if (!omitBlankLines) {
    return {
      write: (data) => stream.write(data),
      flush: () => {},
    };
  }

  let pending = '';
  return {
    write: (data) => {
      pending += data;
      const lines = pending.split(/\r?\n/);
      let ready = true;
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!isBlankLine(line) && !stream.write(`${line}\n`)) ready = false;
      }
      return ready;
    },
    flush: () => {
      if (!isBlankLine(pending)) {
        stream.write(pending);
      }
      pending = '';
    },
  };
}

function isBlankLine(line: string): boolean {
  return line.replaceAll(ANSI_ESCAPE_CODE_REGEXP, '').trim().length === 0;
}
