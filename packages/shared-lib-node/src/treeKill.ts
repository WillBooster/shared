import { execFile } from 'node:child_process';

export async function treeKill(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid: ${pid}`);
  }

  if (process.platform === 'win32') {
    await killTreeOnWindows(pid);
    return;
  }

  const descendants = await collectDescendantPids(pid);
  const targetPids = [...descendants, pid].toReversed();
  for (const targetPid of targetPids) {
    killIfNeeded(targetPid, signal);
  }
}

function killIfNeeded(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return;
    }
    throw error;
  }
}

async function killTreeOnWindows(pid: number): Promise<void> {
  try {
    await runCommand('taskkill', ['/PID', String(pid), '/T', '/F'], {
      maxBuffer: 1024 * 1024,
      timeout: 2000,
    });
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return;
    }
    throw error;
  }
}

async function collectDescendantPids(rootPid: number): Promise<number[]> {
  const { stdout } = await runCommand(
    'ps',
    ['-Ao', 'pid=,ppid='],
    // Keep command bounded so watch-mode kill loops cannot hang this path.
    { maxBuffer: 1024 * 1024, timeout: 2000 }
  );
  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const matched = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!matched) {
      continue;
    }

    const childPid = Number(matched[1]);
    const parentPid = Number(matched[2]);
    const children = childrenByParent.get(parentPid);
    if (children) {
      children.push(childPid);
    } else {
      childrenByParent.set(parentPid, [childPid]);
    }
  }

  const descendants: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const pid = queue.shift()!;
    descendants.push(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) {
      queue.push(childPid);
    }
  }
  return descendants;
}

async function runCommand(
  command: string,
  args: readonly string[],
  options?: { timeout: number; maxBuffer: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', maxBuffer: options?.maxBuffer, timeout: options?.timeout },
      (error, stdout, stderr) => {
        if (error) {
          reject(new CommandExecutionError(command, args, stderr, toExitCode(error)));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function isNoSuchProcessError(error: unknown): boolean {
  if (isErrnoException(error) && error.code === 'ESRCH') {
    return true;
  }

  if (error instanceof CommandExecutionError) {
    return /no such process|not found|not recognized|there is no running instance/i.test(error.stderr);
  }
  return false;
}

function toExitCode(error: unknown): number | string | undefined {
  if (isErrnoException(error)) {
    return error.code;
  }
  return undefined;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

class CommandExecutionError extends Error {
  readonly stderr: string;
  readonly code: number | string | undefined;

  constructor(command: string, args: readonly string[], stderr: string, code: number | string | undefined) {
    super(`Command failed: ${command} ${args.join(' ')}`);
    this.name = 'CommandExecutionError';
    this.stderr = stderr;
    this.code = code;
  }
}
