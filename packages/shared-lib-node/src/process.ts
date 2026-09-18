import { isErrnoException } from './errno.js';

/**
 * Whether a pid names a live process; EPERM means alive, just not signalable by us.
 * A non-positive value names a process GROUP to `process.kill`, which would answer "alive" for
 * something that is no process at all (`0` is the caller's own group), so it is refused here:
 * callers read a pid out of a file or a command's output, where a truncated read yields `0`.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === 'EPERM';
  }
}
