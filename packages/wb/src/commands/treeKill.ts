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
  async handler(argv) {
    const signal = (argv.signal as NodeJS.Signals | undefined) ?? 'SIGTERM';
    await treeKill(Number(argv.pid), signal);
  },
};
