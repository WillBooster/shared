import { spawn } from 'node:child_process';

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
    await runCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return;
    }
    throw error;
  }
}

async function collectDescendantPids(rootPid: number): Promise<number[]> {
  const { stdout } = await runCommand('ps', ['-Ao', 'pid=,ppid=']);
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
    const pid = queue.shift();
    if (!pid) {
      continue;
    }

    descendants.push(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) {
      queue.push(childPid);
    }
  }
  return descendants;
}

async function runCommand(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (data: string) => {
      stdout += data;
    });
    proc.stderr.on('data', (data: string) => {
      stderr += data;
    });
    proc.on('error', (error) => {
      reject(error);
    });
    proc.on('close', (status) => {
      if (status === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new CommandExecutionError(command, args, status, stderr));
      }
    });
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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

class CommandExecutionError extends Error {
  readonly status: number | null;
  readonly stderr: string;

  constructor(command: string, args: readonly string[], status: number | null, stderr: string) {
    super(`Command failed: ${command} ${args.join(' ')}`);
    this.name = 'CommandExecutionError';
    this.status = status;
    this.stderr = stderr;
  }
}
