import child_process from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import chalk from 'chalk';
import type { Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject, type Project } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const builder = {} as const;
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
const maintenanceServerSource = String.raw`
import http from 'node:http';

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error('PORT environment variable is invalid.');
  process.exit(1);
}

const body = ${JSON.stringify(maintenanceHtml)};

const server = http.createServer((_request, response) => {
  response.writeHead(503, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
    'retry-after': '300',
  });
  response.end(body);
});

server.listen(port, '0.0.0.0');
`;

export const maintenanceCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>
> = {
  command: 'maintenance <action>',
  describe: 'Start or stop a lightweight maintenance page server.',
  builder: (yargs: Argv<unknown>) =>
    yargs
      .positional('action', {
        choices: ['start', 'stop'] as const,
        describe: 'Maintenance server action',
        type: 'string',
      })
      .options(builder) as unknown as Argv<InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>>,
  async handler(argv) {
    const project = findSelfProject(argv);
    if (!project) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const port = parsePort(project.env.PORT);
    const action = String(argv.action);
    if (action === 'start') {
      await startMaintenanceServer(project, port);
      return;
    }
    if (action === 'stop') {
      stopMaintenanceServer(project, port);
      return;
    }

    throw new Error(`Unknown maintenance action: ${action}`);
  },
};

async function startMaintenanceServer(project: Project, port: number): Promise<void> {
  const pidPath = getPidPath(project, port);
  const existingPid = readPid(pidPath);
  if (existingPid !== undefined && isProcessRunning(existingPid)) {
    console.info(`Maintenance server is already running on port ${port}.`);
    return;
  }
  removePidFile(pidPath);

  await assertPortAvailable(port);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });

  const child = child_process.spawn(process.execPath, ['--input-type=module', '--eval', maintenanceServerSource], {
    detached: true,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  if (child.pid === undefined) {
    throw new Error('Failed to start maintenance server.');
  }

  fs.writeFileSync(pidPath, `${child.pid}\n`);
  child.unref();
  console.info(`Started maintenance server on port ${port}.`);
}

function stopMaintenanceServer(project: Project, port: number): void {
  const pidPath = getPidPath(project, port);
  const pid = readPid(pidPath);
  if (pid === undefined) {
    console.info(`Maintenance server is not running on port ${port}.`);
    return;
  }

  if (isProcessRunning(pid)) {
    process.kill(pid, 'SIGTERM');
  }
  removePidFile(pidPath);
  console.info(`Stopped maintenance server on port ${port}.`);
}

function parsePort(portEnv: string | undefined): number {
  const port = Number(portEnv);
  if (!Number.isInteger(port) || port <= 0) {
    console.error(chalk.red(`PORT environment variable is invalid: ${portEnv}`));
    process.exit(1);
  }
  return port;
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    server.listen(port, '0.0.0.0');
  }).catch((error) => {
    console.error(chalk.red(`Port ${port} is already in use.`));
    throw error;
  });
}

function getPidPath(project: Project, port: number): string {
  return path.join(project.rootDirPath, '.tmp', `wb-maintenance-server-${port}.pid`);
}

function readPid(pidPath: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removePidFile(pidPath: string): void {
  try {
    fs.rmSync(pidPath, { force: true });
  } catch {
    // do nothing
  }
}
