import { isErrnoException } from './errno.js';

/** Whether a pid names a live process; EPERM means alive, just not signalable by us. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === 'EPERM';
  }
}
