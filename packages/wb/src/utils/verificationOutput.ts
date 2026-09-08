import fs from 'node:fs';
import path from 'node:path';
import { Console } from 'node:console';
import { Writable } from 'node:stream';

let capturingVerificationOutput = false;

/** Runners use this flag to stream raw output into the capture instead of filtering or replaying it. */
export function isCapturingVerificationOutput(): boolean {
  return capturingVerificationOutput;
}

/** Saves output as it arrives; successful verification exposes only its final recap. */
export function startVerificationOutput(logPath: string): {
  startStep: (name?: string) => void;
  succeed: () => void;
  finish: () => Promise<void>;
} {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFile = fs.openSync(logPath, 'w+');
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsole = globalThis.console;
  stdoutWrite(`Full log: ${logPath}\n`);
  let logSize = 0;
  let stepStart = 0;
  let stepName: string | undefined;
  let succeeded = false;
  let finished = false;
  capturingVerificationOutput = true;

  const capture = (original: typeof process.stdout.write, stream: NodeJS.WriteStream): typeof original =>
    ((chunk, encodingOrCallback, callback) => {
      const buffer =
        typeof chunk === 'string'
          ? Buffer.from(chunk, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8')
          : chunk;
      logSize += fs.writeSync(logFile, buffer);
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (succeeded) return original.call(stream, buffer, undefined, done);
      if (done) queueMicrotask(done);
      return true;
    }) as typeof original;

  process.stdout.write = capture(stdoutWrite, process.stdout);
  process.stderr.write = capture(stderrWrite, process.stderr);

  // A custom stream also captures Bun's console, which can bypass process.stdout.write.
  globalThis.console = new Console({
    stdout: forward(process.stdout),
    stderr: forward(process.stderr),
  }) as typeof console;

  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    capturingVerificationOutput = false;
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    globalThis.console = originalConsole;
    process.removeListener('exit', onExit);
    const tail = succeeded ? '' : readFailureTail(logFile, stepStart, logSize);
    fs.closeSync(logFile);
    const message = `${succeeded ? 'Full log' : 'Verification failed. Full log'}: ${logPath}\n`;
    fs.appendFileSync(logPath, message);
    const output = succeeded
      ? message
      : `Failed step: ${stepName ?? 'verification setup'} (exit code ${process.exitCode ?? 1})\n${tail}${message}`;
    await new Promise<void>((resolve, reject) => {
      stdoutWrite(output, (error) => (error ? reject(error) : resolve()));
    });
  };
  // An unexpected process.exit() still closes the saved log. Normal failures await the flush.
  const onExit = (): void => {
    void finish();
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
