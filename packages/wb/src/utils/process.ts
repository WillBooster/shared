import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

import { spawnAsync } from '@willbooster/shared-lib-node/src';

import type { Project } from '../project.js';
import { printFinishedAndExitIfNeeded, printStart } from '../scripts/run.js';

import { isPortAvailable } from './port.js';

const killed = new Set<number | string>();
const staleProcessPollIntervalMs = 100;
const staleProcessMaxPolls = 10;
const portAvailabilityPollIntervalMs = 100;
const portAvailabilityTimeoutMs = 5000;
const portAvailabilityMaxPolls = portAvailabilityTimeoutMs / portAvailabilityPollIntervalMs;

export async function killPortProcessImmediatelyAndOnExit(port: number, project: Project): Promise<void> {
  const available = await isPortAvailable(port);
  if (!available) {
    await killPortContainerAndProcess(port, project);
  }

  const killFunc = async (): Promise<void> => {
    if (killed.has(port)) return;

    killed.add(port);
    await killPortContainerAndProcess(port, project);
  };
  for (const signal of ['beforeExit', 'SIGINT', 'SIGTERM', 'SIGQUIT']) {
    process.on(signal, killFunc);
  }
}

export async function killPortContainerAndProcess(port: number, project: Project): Promise<void> {
  await stopDockerContainerByPort(port, project);
  killListeningProcessesByPort(port);
  await waitForPortToBeAvailable(port);
}

function killListeningProcessesByPort(port: number): void {
  for (const pid of listListeningProcessIds(port)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // do nothing
    }
  }
}

function listListeningProcessIds(port: number): number[] {
  try {
    const stdout = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return stdout
      .split(/\s+/)
      .map((pid) => Number(pid.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

export async function removeStaleProcess(pid: number): Promise<void> {
  for (let i = 0; i < staleProcessMaxPolls; i++) {
    await setTimeout(staleProcessPollIntervalMs);
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // do nothing
  }
}

async function waitForPortToBeAvailable(port: number): Promise<void> {
  for (let i = 0; i < portAvailabilityMaxPolls; i++) {
    if (await isPortAvailable(port)) return;

    await setTimeout(portAvailabilityPollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for port ${port} to become available after ${portAvailabilityTimeoutMs / 1000} seconds.`
  );
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
