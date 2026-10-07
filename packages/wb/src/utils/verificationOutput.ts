import fs from 'node:fs';
import path from 'node:path';
import { Console } from 'node:console';
import { Writable } from 'node:stream';

let capturingVerificationOutput = false;

/** Runners use this flag to stream raw output into the capture instead of filtering or replaying it. */
export function isCapturingVerificationOutput(): boolean {
  return capturingVerificationOutput;
}

/** Saves output as it arrives and shows a verification recap. */
export function startVerificationOutput(logPath: string): {
  startStep: (name?: string) => void;
  succeed: () => void;
  finish: (exitCode: number) => Promise<void>;
} {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFile = fs.openSync(logPath, 'w+');
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsole = globalThis.console;
  stdoutWrite(`Full log: ${logPath}\n`);
  let logSize = 0;
  let logError: Error | undefined;
  let stepStart = 0;
  let stepName: string | undefined;
  let succeeded = false;
  let finished = false;
  capturingVerificationOutput = true;

  const appendToLog = (buffer: Uint8Array): void => {
    if (logError) return;
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const written = fs.writeSync(logFile, buffer, offset, buffer.length - offset);
        if (written === 0) throw new Error('Log write made no progress');
        offset += written;
        logSize += written;
      }
    } catch (error) {
      logError = toError(error, 'Unknown log write error');
    }
  };
  const capture = (original: typeof process.stdout.write, stream: NodeJS.WriteStream): typeof original =>
    captureWrite(original, stream, appendToLog, () => succeeded || Boolean(logError));

  process.stdout.write = capture(stdoutWrite, process.stdout);
  process.stderr.write = capture(stderrWrite, process.stderr);

  // A custom stream also captures Bun's console, which can bypass process.stdout.write.
  globalThis.console = new Console({
    stdout: forward(process.stdout),
    stderr: forward(process.stderr),
  }) as typeof console;

  const finish = async (exitCode: number): Promise<void> => {
    if (finished) return;
    finished = true;
    capturingVerificationOutput = false;
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    globalThis.console = originalConsole;
    process.removeListener('exit', onExit);
    let tail = '';
    const message = `${succeeded ? 'Full log' : 'Verification failed. Full log'}: ${logPath}\n`;
    try {
      try {
        tail = succeeded ? '' : readFailureTail(logFile, stepStart, logSize);
      } finally {
        fs.closeSync(logFile);
      }
      if (!logError) fs.appendFileSync(logPath, message);
    } catch (error) {
      logError ??= toError(error, 'Unknown log I/O error');
    }
    if (logError && !exitCode) process.exitCode = 1;
    const output = succeeded
      ? message
      : `Failed step: ${stepName ?? 'verification setup'} (exit code ${exitCode})\n${tail}${message}`;
    await Promise.all([
      flush(stdoutWrite, `${output}${logError ? `Log incomplete: ${String(logError)}\n` : ''}`),
      flush(stderrWrite, ''),
    ]);
  };
  // An unexpected process.exit() still closes the saved log. Normal failures await the flush.
  const onExit = (exitCode: number): void => {
    void finish(exitCode);
  };
  process.once('exit', onExit);
  return {
    startStep: (name) => {
      stepName = name;
      stepStart = logSize;
    },
    succeed: () => {
      succeeded = true;
    },
    finish,
  };
}

/** Replaces a stream's `write` to save every chunk and show it only while `isShown()`. */
function captureWrite(
  original: typeof process.stdout.write,
  stream: NodeJS.WriteStream,
  save: (buffer: Uint8Array) => void,
  isShown: () => boolean
): typeof original {
  return ((chunk, encodingOrCallback, callback) => {
    const buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8')
        : chunk;
    save(buffer);
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (isShown()) return original.call(stream, buffer, undefined, done);
    if (done) queueMicrotask(done);
    return true;
  }) as typeof original;
}

function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

function flush(write: typeof process.stdout.write, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    write(text, (error) => (error ? reject(error) : resolve()));
  });
}

function forward(stream: NodeJS.WriteStream): Writable {
  return new Writable({
    write(chunk, encoding, callback) {
      stream.write(chunk, encoding);
      callback();
    },
  });
}

/** Reads only the failed step's bounded tail, without loading the full log into memory. */
function readFailureTail(fd: number, start: number, end: number): string {
  const offset = Math.max(start, end - 16 * 1024);
  const buffer = Buffer.alloc(end - offset);
  fs.readSync(fd, buffer, 0, buffer.length, offset);
  // A byte limit can land inside a UTF-8 character; omit its continuation bytes.
  let first = 0;
  while (first < buffer.length && (buffer[first]! & 0xC0) === 0x80) first++;
  const text = buffer.subarray(first).toString('utf8');
  const lines = text.replace(/\n$/, '').split('\n');
  const truncated = offset > start || lines.length > 100;
  const tail = lines.slice(-100).join('\n');
  return `${truncated ? '[Output truncated: failed step tail, at most 100 lines / 16 KiB]\n' : ''}${tail}${tail ? '\n' : ''}`;
}
