import child_process from 'node:child_process';
import fs from 'node:fs/promises';

import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { promisePool } from '../promisePool.js';
import { sharedOptions } from '../sharedOptions.js';

const builder = {
  ...sharedOptions,
  ci: {
    description: 'Whether or not to enable CI mode',
    type: 'boolean',
    default: false,
  },
} as const;

export const setup: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'setup',
  describe: 'Setup development environment',
  builder,
  async handler(argv) {
    const dirents = await fs.readdir('.', { withFileTypes: true });
    if (dirents.some((d) => d.isFile() && d.name.includes('-version'))) {
      await runCommand('asdf', ['install']);
    }
    if (dirents.some((d) => d.isFile() && d.name === 'pyproject.toml')) {
      await runCommand('poetry', ['install', '--ansi']);
    }
  },
};

async function runCommand(command: string, args: string[]): Promise<void> {
  console.info(chalk.green('Starting:'), command);

  await promisePool.run(async () => {
    const proc = child_process.spawn(command, args, { stdio: 'pipe' });
    let output = '';
    await new Promise((resolve) => {
      proc.stdout.on('data', (data) => {
        output += data;
      });
      proc.stderr.on('data', (data) => {
        output += data;
      });
      proc.on('close', (code) => {
        console.info(chalk.cyan('Finished:'), command, `with exit code: ${code}`);
        console.info('------------ start of output ------------');
        console.info(output.trim());
        console.info('------------- end of output -------------');
        console.info();
        resolve(undefined);
      });
    });
  });
}
