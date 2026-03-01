import { constants } from 'node:os';

import { treeKill } from '@willbooster/shared-lib-node/src';
import type { CommandModule } from 'yargs';

const builder = {
  signal: {
    description: 'Signal to send to the process tree.',
    type: 'string',
    default: 'SIGTERM',
  },
} as const;

export const treeKillCommand: CommandModule = {
  command: 'tree-kill <pid> [signal]',
  describe: 'Kill the given process and all descendants',
  builder,
  handler(argv) {
    try {
      const signal = argv.signal as NodeJS.Signals;
      if (!(signal in constants.signals)) {
        throw new Error(`Invalid signal: ${signal}`);
      }
      treeKill(Number(argv.pid), signal);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  },
};
