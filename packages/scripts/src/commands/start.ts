import child_process from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { execute } from '@yarnpkg/shell';
import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

const builder = {
  command: {
    description: 'A build mode',
    type: 'string',
    default: 'yarn build',
    alias: 'p',
  },
  'working-dir': {
    description: 'A working directory',
    type: 'string',
    default: '.',
    alias: 'w',
  },
} as const;

export const start: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'start',
  describe: 'Start app',
  builder,
  async handler(argv) {
    console.log('start:', argv);

    const workingDirectory = path.resolve(argv.workingDir);
    process.chdir(workingDirectory);

    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
    if (packageJson.dependencies?.['blitz']) {
      process.exitCode = await execute('yarn', ['blitz', 'dev']);
    }
  },
};
