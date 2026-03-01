import { execFileSync } from 'node:child_process';

import { isErrnoException } from './errno.js';
import { buildChildrenByParentMap, collectDescendantPids as collectDescendantPidsFromMap } from './processTree.js';

export function treeKill(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid: ${pid}`);
  }

  if (process.platform === 'win32') {
    killTreeOnWindows(pid);
    return;
  }

  const descendants = collectDescendantPids(pid);
  const targetPids = toChildrenFirstPids(pid, descendants);
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

function killTreeOnWindows(pid: number): void {
  try {
    runCommand('taskkill', ['/PID', String(pid), '/T', '/F'], {
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

function collectDescendantPids(rootPid: number): number[] {
  const { stdout } = runCommand(
    'ps',
    ['-Ao', 'pid=,ppid='],
    // Keep command bounded so watch-mode kill loops cannot hang this path.
    { maxBuffer: 1024 * 1024, timeout: 2000 }
  );
  const childrenByParent = buildChildrenByParentMap(stdout);
  return collectDescendantPidsFromMap(rootPid, childrenByParent);
}

function toChildrenFirstPids(pid: number, descendants: readonly number[]): number[] {
  const targetPids: number[] = [];
  for (let index = descendants.length - 1; index >= 0; index--) {
    const descendantPid = descendants[index];
    if (descendantPid !== undefined) {
      targetPids.push(descendantPid);
    }
  }
  targetPids.push(pid);
  return targetPids;
}

function runCommand(
  command: string,
  args: readonly string[],
  options?: { timeout: number; maxBuffer: number }
): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(command, [...args], {
      encoding: 'utf8',
      maxBuffer: options?.maxBuffer,
      timeout: options?.timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '' };
  } catch (error) {
    const stderr = extractStderr(error);
    throw new CommandExecutionError(command, args, stderr, toExitCode(error));
  }
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

function extractStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) {
    return '';
  }

  const stderr = (error as Record<'stderr', unknown>).stderr;
  if (typeof stderr === 'string') {
    return stderr;
  }
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString('utf8');
  }
  return '';
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
