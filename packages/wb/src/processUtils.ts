import { spawnSync } from 'node:child_process';

import killPortProcess from 'kill-port';

import type { Project } from './project.js';
import { printFinishedAndExitIfNeeded, printStart } from './scripts/run.js';

const killed = new Set<number | string>();

export async function killPortProcessImmediatelyAndOnExit(port: number): Promise<void> {
  await killPortProcessHandlingErrors(port);
  const killFunc = async (): Promise<void> => {
    if (killed.has(port)) return;

    killed.add(port);
    await killPortProcessHandlingErrors(port);
  };
  for (const signal of ['beforeExit', 'SIGINT', 'SIGTERM', 'SIGQUIT']) {
    process.on(signal, killFunc);
  }
}

async function killPortProcessHandlingErrors(port: number): Promise<void> {
  try {
    await killPortProcess(port);
  } catch {
    // do nothing
  }
}

export function spawnSyncOnExit(project: Project, command: string): void {
  const killFunc = async (): Promise<void> => {
    if (killed.has(command)) return;

    killed.add(command);
    printStart(command);
    const { status } = spawnSync(command, { cwd: project.dirPath, shell: true, stdio: 'inherit' });
    printFinishedAndExitIfNeeded(command, status, {});
  };
  for (const signal of ['beforeExit', 'SIGINT', 'SIGTERM', 'SIGQUIT']) {
    process.on(signal, killFunc);
  }
}
