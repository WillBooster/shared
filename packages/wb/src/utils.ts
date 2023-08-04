import { spawnSync } from 'node:child_process';

import killPortProcess from 'kill-port';

const killed = new Set<number | string>();

export async function killPortProcessImmediatelyAndOnExit(port: number): Promise<void> {
  await killPortProcessHandlingErrors(port);
  const killFunc = async (): Promise<void> => {
    if (killed.has(port)) return;

    killed.add(port);
    await killPortProcessHandlingErrors(port);
  };
  process.on('beforeExit', killFunc);
  process.on('SIGINT', killFunc);
}

async function killPortProcessHandlingErrors(port: number): Promise<void> {
  try {
    await killPortProcess(port);
  } catch {
    // do nothing
  }
}

export function spawnSyncOnExit(command: string): void {
  const killFunc = async (): Promise<void> => {
    if (killed.has(command)) return;

    killed.add(command);
    spawnSync(command, { shell: true, stdio: 'inherit' });
  };
  process.on('beforeExit', killFunc);
  process.on('SIGINT', killFunc);
}
