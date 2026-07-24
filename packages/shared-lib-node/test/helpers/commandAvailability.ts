import childProcess from 'node:child_process';

export function isMiseAvailable(): boolean {
  return childProcess.spawnSync('mise', ['--version'], { stdio: 'ignore' }).status === 0;
}

export function isFnoxAvailable(): boolean {
  return childProcess.spawnSync('fnox', ['--version'], { stdio: 'ignore' }).status === 0;
}
