import chalk from 'chalk';
import killPortProcess from 'kill-port';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const killPortIfNonCiBuilder = {} as const;

export const killPortIfNonCiCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof killPortIfNonCiBuilder & typeof sharedOptionsBuilder>
> = {
  command: 'kill-port-if-non-ci',
  describe: 'Kill the port specified by PORT environment variable if non-CI.',
  builder: killPortIfNonCiBuilder,
  async handler(argv) {
    await killPortIfNonCi(argv);
  },
};

export async function killPortIfNonCi(
  _: ArgumentsCamelCase<InferredOptionTypes<typeof killPortIfNonCiBuilder & typeof sharedOptionsBuilder>>
): Promise<void> {
  if (!process.env.CI || (process.env.CI !== '0' && process.env.CI !== 'false')) return;

  const portEnv = process.env.PORT;
  const port = Number(portEnv);
  if (!Number.isInteger(port) || port <= 0) {
    console.error(chalk.red(`PORT environment variable is invalid: ${portEnv}`));
    process.exit(1);
  }

  try {
    await killPortProcess(port);
  } catch {
    // do nothing
  }
}
