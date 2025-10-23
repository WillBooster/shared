import net from 'node:net';

import chalk from 'chalk';
import killPortProcess from 'kill-port';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const killPortOnCiBuilder = {} as const;

export const killPortOnCiCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof killPortOnCiBuilder & typeof sharedOptionsBuilder>
> = {
  command: 'kill-port-on-ci',
  describe: 'Kill the port specified by PORT environment variable on CI.',
  builder: killPortOnCiBuilder,
  async handler(argv) {
    await killPortOnCi(argv);
  },
};

export async function killPortOnCi(
  argv: ArgumentsCamelCase<InferredOptionTypes<typeof killPortOnCiBuilder & typeof sharedOptionsBuilder>>
): Promise<void> {
  const portEnv = process.env.PORT;
  if (!portEnv) {
    console.error(chalk.red('PORT environment variable is not set.'));
    process.exit(1);
  }

  const port = Number(portEnv);
  if (!Number.isInteger(port) || port <= 0) {
    console.error(chalk.red(`PORT environment variable is invalid: ${portEnv}`));
    process.exit(1);
  }

  if (argv['dry-run']) {
    if (argv.verbose) {
      console.info(`Skipping kill-port-on-ci because dry-run mode is enabled. Target port: ${port}`);
    }
    return;
  }

  await killPortProcess(port);
  await waitUntilPortIsFree(port);
}

async function waitUntilPortIsFree(port: number, timeoutMs = 30_000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await canBindToPort(port)) return;
    await delay(intervalMs);
  }

  console.error(chalk.red(`Failed to free port ${port} within ${timeoutMs}ms.`));
  process.exit(1);
}

async function canBindToPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, '0.0.0.0');
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
