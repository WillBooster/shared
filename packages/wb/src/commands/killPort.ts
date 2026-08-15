import chalk from 'chalk';
import type { Argv, CommandModule, InferredOptionTypes } from 'yargs';

import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { killListeningProcessesByPort } from '../utils/process.js';

const argumentsBuilder = {
  ports: {
    array: true,
    description: 'TCP ports to free',
    type: 'string',
  },
} as const;

export const killPortCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof argumentsBuilder & typeof sharedOptionsBuilder>
> = {
  command: 'kill-port <ports..>',
  describe: 'Kill the processes listening on the given TCP ports',
  builder: (yargs: Argv<unknown>) =>
    yargs.positional('ports', argumentsBuilder.ports) as Argv<
      InferredOptionTypes<typeof argumentsBuilder & typeof sharedOptionsBuilder>
    >,
  handler(argv) {
    try {
      killPorts(argv.ports ?? [], argv.dryRun);
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  },
};

export function killPorts(ports: string[], dryRun?: boolean): void {
  // Parse every port before killing any, so an invalid argument frees no port at all.
  const parsedPorts = ports.map(parsePort);
  if (dryRun) {
    console.info(chalk.cyan(`Would kill the processes listening on the ports: ${parsedPorts.join(', ')}`));
    return;
  }
  for (const port of parsedPorts) {
    console.info(`Killing the port: ${port}`);
    killListeningProcessesByPort(port);
  }
}

function parsePort(port: string): number {
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65_535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return parsedPort;
}
