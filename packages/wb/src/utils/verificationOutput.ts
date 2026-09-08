import fs from 'node:fs';
import path from 'node:path';
import { Console } from 'node:console';
import { Writable } from 'node:stream';

let capturingVerificationOutput = false;

export function isCapturingVerificationOutput(): boolean {
  return capturingVerificationOutput;
}

/** Saves output as it arrives; successful verification exposes only its final recap. */
export function startVerificationOutput(logPath: string): { succeed: () => void; finish: () => Promise<void> } {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFile = fs.openSync(logPath, 'w');
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsole = globalThis.console;
  let succeeded = false;
  let finished = false;
  capturingVerificationOutput = true;

  const capture = (original: typeof process.stdout.write, stream: NodeJS.WriteStream): typeof original =>
    ((chunk, encodingOrCallback, callback) => {
      const buffer =
        typeof chunk === 'string'
          ? Buffer.from(chunk, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8')
          : chunk;
      fs.writeSync(logFile, buffer);
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
    fs.closeSync(logFile);
    const message = `${succeeded ? 'Full log' : 'Verification failed. Full log'}: ${logPath}\n`;
    fs.appendFileSync(logPath, message);
    const output = succeeded ? message : fs.readFileSync(logPath);
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
