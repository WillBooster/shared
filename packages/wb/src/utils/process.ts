import { spawnSync } from 'node:child_process';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import killPortProcess from 'kill-port';

import type { Project } from '../project.js';
import { printFinishedAndExitIfNeeded, printStart } from '../scripts/run.js';

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

export async function stopDockerContainerByImageName(imageName: string, project: Project): Promise<void> {
  await removeDockerContainers(['--filter', `name=${imageName}`], project);
}

export async function stopDockerContainerByPort(port: number, project: Project): Promise<void> {
  await removeDockerContainers(['--filter', `publish=${port}`], project);
}

async function removeDockerContainers(filterArgs: string[], project: Project): Promise<void> {
  try {
    const containerIds = await listDockerContainerIds(filterArgs, project);
    if (containerIds.length === 0) return;

    await spawnAsync('docker', ['rm', '-f', ...containerIds], {
      cwd: project.dirPath,
      env: project.env,
    });
  } catch {
    // do nothing
  }
}

async function listDockerContainerIds(filterArgs: string[], project: Project): Promise<string[]> {
  const { stdout } = await spawnAsync('docker', ['ps', '-q', ...filterArgs], {
    cwd: project.dirPath,
    env: project.env,
  });
  return stdout
    .split(/\s+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

export function spawnSyncOnExit(script: string, project: Project): void {
  const killFunc = (): void => {
    if (killed.has(script)) return;

    killed.add(script);
    printStart(script, project);
    const { status } = spawnSync(script, { cwd: project.dirPath, shell: true, stdio: 'inherit' });
    printFinishedAndExitIfNeeded(script, status, {});
  };
  for (const signal of ['beforeExit', 'SIGINT', 'SIGTERM', 'SIGQUIT']) {
    process.on(signal, killFunc);
  }
}
