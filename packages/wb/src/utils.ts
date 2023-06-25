import { spawnSync } from 'node:child_process';

import { killPortProcess } from 'kill-port-process';

const killed = new Set<number | string>();

export async function killPortProcessImmediatelyAndOnExit(port: number): Promise<void> {
  await killPortProcess(port);
  process.on('beforeExit', async () => {
    if (killed.has(port)) return;

    killed.add(port);
    await killPortProcess(port);
  });
}

export function spawnSyncOnExit(command: string): void {
  process.on('beforeExit', () => {
    if (killed.has(command)) return;

    killed.add(command);
    spawnSync(command, { shell: true, stdio: 'inherit' });
  });
}
