import childProcess from 'node:child_process';

export function isMiseAvailable(): boolean {
  return isCommandAvailable('mise');
}

export function isFnoxAvailable(): boolean {
  return isCommandAvailable('fnox');
}

function isCommandAvailable(command: string): boolean {
  return childProcess.spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}
