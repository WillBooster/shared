import fs from 'node:fs/promises';
import path from 'node:path';

import { execute } from '@yarnpkg/shell';
import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

const builder = {
  command: {
    description: 'A running mode',
    type: 'string',
    default: 'yarn build',
    alias: 'm',
  },
} as const;

export const start: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'start',
  describe: 'Start app',
  builder,
  async handler(argv) {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
    if (packageJson.dependencies?.['blitz']) {
      process.exitCode = await execute('yarn', [
        'concurrently',
        '--kill-others-on-fail',
        '--raw',
        'blitz dev',
        'wait-on -t 60000 -i 2000 http://127.0.0.1:3000 && open-cli http://localhost:3000',
      ]);
    }
  },
};
