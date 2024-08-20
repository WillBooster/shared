import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject } from '../project.js';
import { runWithSpawn } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const builder = {
  retry: {
    description: 'A maximum retry count',
    type: 'number',
    alias: 'r',
    default: 3,
  },
} as const;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const argumentsBuilder = {
  command: {
    description: 'A command to retry',
    type: 'string',
  },
  args: {
    description: 'Arguments for the command',
    type: 'array',
  },
} as const;

export const retryCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder & typeof argumentsBuilder>
> = {
  command: 'retry [command] [args...]',
  describe: 'Retry the given command until it succeeds',
  builder,
  async handler(argv) {
    const project = findSelfProject(argv);
    if (!project) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const cmdAndArgs = [argv.command, ...(argv.args ?? []), ...argv._.slice(1)].filter(Boolean);
    let lastStatus = 0;
    for (let i = 0; i < argv.retry; i++) {
      if (i > 0) {
        console.info(`\n${chalk.yellow(`#${i} Retrying: ${cmdAndArgs.join(' ')}`)}`);
      }
      // TODO: should we add single quotes around each argument?
      lastStatus = await runWithSpawn(cmdAndArgs.join(' '), project, argv, {
        exitIfFailed: false,
      });
      if (lastStatus === 0) return;
    }
    process.exit(lastStatus);
  },
};
