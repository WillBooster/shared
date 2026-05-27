import assert from 'node:assert';
import { once } from 'node:events';
import http from 'node:http';

import chalk from 'chalk';
import type { Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject, type Project } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { killPortContainerAndProcess } from '../utils/process.js';

const builder = {} as const;
type MaintenanceArgv = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder> & {
  action: 'start' | 'stop';
};
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
      await startMaintenanceServer(project, port);
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

async function startMaintenanceServer(project: Project, port: number): Promise<void> {
  await killPortContainerAndProcess(port, project);
  const server = createMaintenanceServer();
  server.on('error', (error) => {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') {
      console.error(chalk.red(`Port ${port} is already in use.`));
    } else {
      console.error(chalk.red(`Maintenance server error: ${error.message}`));
    }
    process.exit(1);
  });
  await listenMaintenanceServer(server, port);
  console.info(`Started maintenance server on port ${port}.`);
  await waitForShutdown(server);
}

async function stopMaintenanceServer(project: Project, port: number): Promise<void> {
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

async function listenMaintenanceServer(server: http.Server, port: number): Promise<void> {
  const listening = once(server, 'listening');
  server.listen(port, '0.0.0.0');
  await listening;
}

async function waitForShutdown(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      process.off('SIGQUIT', shutdown);
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.once('SIGQUIT', shutdown);
  });
}
