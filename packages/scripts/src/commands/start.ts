import fs from 'node:fs/promises';

import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { blitzScripts } from '../scripts/blitzScripts.js';
import { runScript } from '../scripts/sharedScripts.js';
import { sharedOptions } from '../sharedOptions.js';

const builder = {
  mode: {
    description: 'Start mode: dev | prod | docker',
    type: 'string',
    alias: 'm',
  },
  ...sharedOptions,
} as const;

export const start: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'start',
  describe: 'Start app',
  builder,
  async handler(argv) {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
    const name = packageJson.name || 'unknown';
    if (packageJson.dependencies?.['blitz']) {
      switch (argv.mode) {
        case 'dev': {
          await runScript(blitzScripts.start(), argv.verbose);
          break;
        }
        case 'prod': {
          await runScript(blitzScripts.startProduction(), argv.verbose);
          break;
        }
        case 'docker': {
          await runScript(blitzScripts.startDocker(name), argv.verbose);
          break;
        }
        default: {
          throw new Error(`Unknown start mode: ${argv.mode}`);
        }
      }
    }
  },
};
