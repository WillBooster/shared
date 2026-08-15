import childProcess from 'node:child_process';

import chalk from 'chalk';
import type { Argv, CommandModule, InferredOptionTypes } from 'yargs';

const argumentsBuilder = {
  target: {
    description: 'URL or file to open',
    type: 'string',
  },
} as const;

export const openCliCommand: CommandModule<unknown, InferredOptionTypes<typeof argumentsBuilder>> = {
  command: 'open-cli <target>',
  describe: 'Open a URL or file in its default application',
  builder: (yargs: Argv<unknown>) =>
    yargs.positional('target', argumentsBuilder.target) as Argv<InferredOptionTypes<typeof argumentsBuilder>>,
  async handler(argv) {
    try {
      if (!argv.target) throw new Error('A URL or file is required.');
      await openTarget(argv.target);
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  },
};

export function openTarget(target: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!command) throw new Error(`Opening targets is unsupported on ${process.platform}.`);

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, [target], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
