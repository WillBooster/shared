import { constants } from 'node:os';

import { treeKill } from '@willbooster/shared-lib-node/src';
import type { Argv, CommandModule } from 'yargs';

interface TreeKillCommandArgs {
  pid: number;
  signal: string;
}

const builder = (yargs: Argv): Argv<TreeKillCommandArgs> =>
  yargs
    .positional('pid', {
      description: 'The process ID to kill.',
      type: 'number',
      demandOption: true,
    })
    .option('signal', {
      description: 'Signal to send to the process tree.',
      type: 'string',
      default: 'SIGTERM',
    }) as Argv<TreeKillCommandArgs>;

export const treeKillCommand: CommandModule<object, TreeKillCommandArgs> = {
  command: 'tree-kill <pid> [signal]',
  describe: 'Kill the given process and all descendants',
  builder,
  handler(argv) {
    try {
      const signal = argv.signal as NodeJS.Signals;
      if (!(signal in constants.signals)) {
        throw new Error(`Invalid signal: ${signal}`);
      }
      treeKill(argv.pid, signal);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  },
};
