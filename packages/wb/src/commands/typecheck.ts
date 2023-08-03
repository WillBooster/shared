import fs from 'node:fs/promises';

import chalk from 'chalk';
import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { runWithSpawn } from '../scripts/run.js';
import { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const builder = {
  ...sharedOptionsBuilder,
} as const;

export const typeCheckCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'typecheck',
  describe: 'Run type checking',
  builder,
  async handler(argv) {
    process.exitCode = await runWithSpawn(`tsc --noEmit --Pretty`, argv);
    if (process.exitCode !== 0) {
      const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
      const deps = packageJson.dependencies || {};
      if (deps['blitz']) {
        console.info(chalk.yellow('Please try "yarn gen-code" if you face unknown type errors.'));
      }
    }
  },
};

export const tcCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  ...typeCheckCommand,
  command: 'tc',
};
