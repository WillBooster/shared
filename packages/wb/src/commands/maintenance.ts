import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

import chalk from 'chalk';
import type { Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject, type Project } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { isPortAvailable } from '../utils/port.js';

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

function getMaintenanceServerSource(port: number, pidPath: string): string {
  return String.raw`
import fs from 'node:fs';
import http from 'node:http';

const port = ${port};
const pidPath = ${JSON.stringify(pidPath)};
const body = ${JSON.stringify(maintenanceHtml)};

const server = http.createServer((_request, response) => {
  response.writeHead(503, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
  });
  response.end(body);
});

server.on('error', () => {
  try {
    fs.rmSync(pidPath, { force: true });
  } catch {
    // do nothing
  }
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  fs.writeFileSync(pidPath, String(process.pid) + '\n');
});
`;
}

export const maintenanceCommand: CommandModule<unknown, MaintenanceArgv> = {
  command: 'maintenance <action>',
  describe: 'Start or stop a lightweight maintenance page server.',
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

    const port = parsePort(project.env.PORT);
    const action = argv.action;
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

  if (!(await isPortAvailable(port))) {
    console.error(chalk.red(`Port ${port} is already in use.`));
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });

  const child = child_process.spawn(
    process.execPath,
    ['--input-type=module', '--eval', getMaintenanceServerSource(port, pidPath)],
    {
      detached: true,
      env: project.env,
      stdio: 'ignore',
    }
  );
  if (child.pid === undefined) {
    throw new Error('Failed to start maintenance server.');
  }

  child.unref();
  await waitForPidFile(pidPath, child.pid);
  console.info(`Started maintenance server on port ${port}.`);
}

function stopMaintenanceServer(project: Project, port: number): void {
  const pidPath = getPidPath(project, port);
  const pid = readPid(pidPath);
  if (pid === undefined) {
    console.info(`Maintenance server is not running on port ${port}.`);
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // do nothing
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

async function waitForPidFile(pidPath: string, pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (readPid(pidPath) !== undefined) return;
    if (!isProcessRunning(pid)) break;
    await setTimeout(50);
  }

  removePidFile(pidPath);
  throw new Error('Failed to start maintenance server.');
}
