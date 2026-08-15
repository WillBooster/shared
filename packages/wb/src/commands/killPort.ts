import chalk from 'chalk';
import type { Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { killListeningProcessesByPort } from '../utils/process.js';

const argumentsBuilder = {
  ports: {
    array: true,
    description: 'TCP ports to free',
    type: 'number',
  },
} as const;

export const killPortCommand: CommandModule<unknown, InferredOptionTypes<typeof argumentsBuilder>> = {
  command: 'kill-port <ports..>',
  describe: 'Kill the processes listening on the given TCP ports',
  builder: (yargs: Argv<unknown>) =>
    yargs.positional('ports', argumentsBuilder.ports) as Argv<InferredOptionTypes<typeof argumentsBuilder>>,
  handler(argv) {
    try {
      killPorts(argv.ports ?? []);
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  },
};

export function killPorts(ports: number[]): void {
  // Validate every port before killing any, so an invalid argument frees no port at all.
  for (const port of ports) {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`Invalid port: ${port}`);
  }
  for (const port of ports) {
    console.info(`Killing the port: ${port}`);
    killListeningProcessesByPort(port);
  }
}
