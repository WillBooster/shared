import net from 'node:net';
import { setTimeout } from 'node:timers/promises';

import chalk from 'chalk';
import type { Argv, CommandModule, InferredOptionTypes } from 'yargs';

const httpRequestTimeoutMs = 5000;

const builder = {
  timeout: {
    alias: 't',
    description: 'Maximum time to wait in milliseconds',
    type: 'number',
  },
  interval: {
    alias: 'i',
    default: 250,
    description: 'Polling interval in milliseconds',
    type: 'number',
  },
} as const;

const argumentsBuilder = {
  resource: {
    description: 'HTTP(S) URL or tcp:<host>:<port> resource',
    type: 'string',
  },
} as const;

export const waitOnCommand: CommandModule<unknown, InferredOptionTypes<typeof builder & typeof argumentsBuilder>> = {
  command: 'wait-on <resource>',
  describe: 'Wait for an HTTP(S) URL or TCP port',
  builder: (yargs: Argv<unknown>) =>
    yargs.options(builder).positional('resource', argumentsBuilder.resource) as Argv<
      InferredOptionTypes<typeof builder & typeof argumentsBuilder>
    >,
  async handler(argv) {
    try {
      if (!argv.resource) throw new Error('A resource is required.');
      await waitOn(argv.resource, { interval: argv.interval, timeout: argv.timeout });
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  },
};

export async function waitOn(
  resource: string,
  { interval, timeout }: { interval: number; timeout?: number }
): Promise<void> {
  if (!Number.isInteger(interval) || interval < 0) throw new Error(`Invalid interval: ${interval}`);
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 0)) {
    throw new Error(`Invalid timeout: ${timeout}`);
  }

  const checkResource = buildResourceCheck(resource, interval);
  const deadline = timeout === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeout;
  while (!(await checkResource(deadline))) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`Timed out waiting for: ${resource}`);
    await setTimeout(Math.min(interval, remainingMs));
  }
}

function buildResourceCheck(resource: string, interval: number): (deadline: number) => Promise<boolean> {
  if (resource.startsWith('tcp:')) {
    const match = /^tcp:(?<host>[^:]+):(?<port>\d+)$/u.exec(resource);
    const host = match?.groups?.host;
    const port = Number(match?.groups?.port);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Invalid TCP resource: ${resource}`);
    }
    return (deadline) => isTcpPortListening(host, port, deadline);
  }

  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    throw new Error(`Unsupported resource: ${resource}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported resource: ${resource}`);
  }
  return (deadline) => isHttpResponding(url, deadline, interval);
}

function isTcpPortListening(host: string, port: number, deadline: number): Promise<boolean> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return Promise.resolve(false);

  return new Promise((resolve) => {
    const socket = net.createConnection({ autoSelectFamily: true, host, port });
    let settled = false;
    const finish = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(Math.min(300, remainingMs), () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function isHttpResponding(url: URL, deadline: number, interval: number): Promise<boolean> {
  try {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    const attemptTimeoutMs = Math.min(remainingMs, Math.max(interval, httpRequestTimeoutMs));
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(
        Number.isFinite(attemptTimeoutMs) ? Math.max(1, attemptTimeoutMs) : httpRequestTimeoutMs
      ),
    });
    return response.ok;
  } catch {
    return false;
  }
}
