import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { treeKill } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject, type Project } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { killPortContainerAndProcess, removeStaleProcess } from '../utils/process.js';

const builder = {
  'delay-ms': {
    default: 5000,
    describe: 'Delay before starting the maintenance page server.',
    type: 'number',
  },
} as const;
type MaintenanceArgv = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder> & {
  action: 'start' | 'stop';
};
const maintenanceListenMaxAttempts = 5;
const maintenanceListenRetryDelayMs = 100;
const maxTimeoutDelayMs = 2_147_483_647;
const maintenancePidDirectoryName = '.wb';
const maintenanceHtml = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>メンテナンス中</title>
    <style>
      body {
        align-items: center;
        background: #f8fafc;
        color: #111827;
        display: flex;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
      }

      main {
        padding: 24px;
        text-align: center;
      }

      h1 {
        font-size: 28px;
        line-height: 1.4;
        margin: 0 0 16px;
      }

      p {
        font-size: 16px;
        line-height: 1.8;
        margin: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>現在メンテナンス中です</h1>
      <p>皆様にはご不便をおかけしますが、メンテナンス終了までしばらくお待ちください。</p>
    </main>
  </body>
</html>`;

export const maintenanceCommand: CommandModule<unknown, MaintenanceArgv> = {
  command: 'maintenance <action>',
  describe: 'Start or stop a lightweight maintenance page server. Example: wb maintenance start',
  builder: (yargs: Argv<unknown>) =>
    yargs
      .positional('action', {
        choices: ['start', 'stop'] as const,
        describe: 'Maintenance server action',
        type: 'string',
      })
      .options(builder) as unknown as Argv<MaintenanceArgv>,
  async handler(argv) {
    const project = findSelfProject(argv);
    if (!project) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const action = argv.action;
    if (project.env.WB_ENV === 'test') {
      console.info(`Skip maintenance ${action} because WB_ENV is test.`);
      return;
    }

    const port = parsePort(project.env.PORT);
    if (action === 'start') {
      await startMaintenanceServer(project, port, argv.delayMs);
      return;
    }
    if (action === 'stop') {
      await stopMaintenanceServer(project, port);
      return;
    }

    throw new Error(`Unknown maintenance action: ${action}`);
  },
};

function parsePort(portEnv: string | undefined): number {
  const port = Number(portEnv);
  assert.ok(Number.isInteger(port) && port > 0, `PORT environment variable is invalid: ${portEnv}`);
  return port;
}

async function startMaintenanceServer(project: Project, port: number, delayMs: number): Promise<void> {
  assert.ok(
    Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= maxTimeoutDelayMs,
    `delay-ms must be between 0 and ${maxTimeoutDelayMs}: ${delayMs}`
  );

  const pidFilePath = await writeMaintenancePidFile(project, port);
  const abortController = new AbortController();
  const cleanup = async (): Promise<void> => {
    await removeMaintenancePidFile(pidFilePath, process.pid);
  };
  const handleSignal = (): void => {
    abortController.abort();
  };
  const removeSignalHandlers = (): void => {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    process.off('SIGQUIT', handleSignal);
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  process.once('SIGQUIT', handleSignal);

  try {
    await setTimeout(delayMs, undefined, { signal: abortController.signal });
    removeSignalHandlers();
    const server = await createAndListenMaintenanceServer(port);
    if (!server) return;

    console.info(`Started maintenance server on port ${port}.`);
    await waitForShutdown(server);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return;

    throw error;
  } finally {
    removeSignalHandlers();
    await cleanup();
  }
}

async function createAndListenMaintenanceServer(port: number): Promise<http.Server | undefined> {
  for (let attempt = 1; attempt <= maintenanceListenMaxAttempts; attempt++) {
    const server = createMaintenanceServer();
    try {
      await listenMaintenanceServer(server, port, handleRuntimeMaintenanceServerError);
      return server;
    } catch (error) {
      await closeMaintenanceServer(server);
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EADDRINUSE' && attempt < maintenanceListenMaxAttempts) {
        await setTimeout(maintenanceListenRetryDelayMs);
        continue;
      }
      if (err.code === 'EADDRINUSE') {
        console.info(`Skip maintenance server because port ${port} is already in use.`);
        return undefined;
      }
      handleMaintenanceStartupError(port, err);
    }
  }

  throw new Error('Unreachable maintenance server startup state.');
}

function handleMaintenanceStartupError(port: number, error: NodeJS.ErrnoException): never {
  if (error.code === 'EADDRINUSE') {
    console.error(chalk.red(`Port ${port} is already in use.`));
  } else {
    console.error(chalk.red(`Maintenance server error: ${error.message}`));
  }
  process.exit(1);
}

function handleRuntimeMaintenanceServerError(error: Error): void {
  console.error(chalk.red(`Maintenance server error: ${error.message}`));
  process.exit(1);
}

async function stopMaintenanceServer(project: Project, port: number): Promise<void> {
  await killMaintenanceProcess(project, port);
  await killPortContainerAndProcess(port, project);
  console.info(`Stopped maintenance server on port ${port}.`);
}

function createMaintenanceServer(): http.Server {
  return http.createServer((_request, response) => {
    response.writeHead(503, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(maintenanceHtml);
  });
}

async function listenMaintenanceServer(
  server: http.Server,
  port: number,
  onRuntimeError: (error: Error) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onStartupError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onStartupError);
      server.on('error', onRuntimeError);
      resolve();
    };
    server.once('error', onStartupError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

async function waitForShutdown(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      process.off('SIGQUIT', shutdown);
      void (async () => {
        try {
          await closeMaintenanceServer(server);
        } catch (error) {
          console.error(chalk.red(`Failed to close maintenance server: ${(error as Error).message}`));
        } finally {
          resolve();
        }
      })();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.once('SIGQUIT', shutdown);
  });
}

async function closeMaintenanceServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
          resolve();
          return;
        }
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}

async function writeMaintenancePidFile(project: Project, port: number): Promise<string> {
  const pidFilePath = maintenancePidFilePath(project, port);
  await fs.mkdir(path.dirname(pidFilePath), { recursive: true });
  await fs.writeFile(pidFilePath, `${process.pid}\n`, 'utf8');
  return pidFilePath;
}

async function killMaintenanceProcess(project: Project, port: number): Promise<void> {
  const pidFilePath = maintenancePidFilePath(project, port);
  const pid = await readMaintenancePidFile(pidFilePath);
  if (pid !== undefined && pid !== process.pid) {
    try {
      treeKill(pid, 'SIGTERM');
    } catch {
      // do nothing
    }
    await removeStaleProcess(pid);
  }
  await removeMaintenancePidFile(pidFilePath, pid);
}

async function removeMaintenancePidFile(pidFilePath: string, expectedPid?: number): Promise<void> {
  if (expectedPid !== undefined) {
    const pid = await readMaintenancePidFile(pidFilePath);
    if (pid !== expectedPid) return;
  }
  await fs.rm(pidFilePath, { force: true });
}

async function readMaintenancePidFile(pidFilePath: string): Promise<number | undefined> {
  try {
    const pidText = await fs.readFile(pidFilePath, 'utf8');
    const pid = Number(pidText.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function maintenancePidFilePath(project: Project, port: number): string {
  return getMaintenancePidFilePath(project.rootDirPath, port);
}

export function getMaintenancePidFilePath(rootDirPath: string, port: number): string {
  return path.join(rootDirPath, maintenancePidDirectoryName, `maintenance-${port}.pid`);
}
