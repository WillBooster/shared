import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { runWithSpawn } from '../scripts/run.js';
import { sharedOptions } from '../sharedOptions.js';

const builder = {
  retry: {
    description: 'A maximum retry count',
    type: 'number',
    alias: 'r',
    default: 3,
  },
  ...sharedOptions,
} as const;

export const retryCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'retry',
  describe: 'Retry the given command until it succeeds',
  builder,
  async handler(argv) {
    const cmdAndArgs = argv._.slice(1);
    let lastStatus = 0;
    for (let i = 0; i < argv.retry; i++) {
      if (i > 0) {
        console.info(`\n${chalk.yellow(`#${i} Retrying: ${cmdAndArgs.join(' ')}`)}`);
      }
      // TODO: should we add single quotes around each argument?
      lastStatus = await runWithSpawn(cmdAndArgs.join(' '), argv, {
        exitIfFailed: false,
      });
      if (lastStatus === 0) return;
    }
    process.exit(lastStatus);
  },
};
