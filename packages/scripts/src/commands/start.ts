import fs from 'node:fs/promises';

import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { blitzScripts } from '../scripts/blitzScripts.js';
import { runWithYarn } from '../scripts/sharedScripts.js';

const builder = {
  mode: {
    description: 'Start mode: dev (default) | prod | docker',
    type: 'string',
    alias: 'm',
  },
} as const;

export const start: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'start',
  describe: 'Start app',
  builder,
  async handler(argv) {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
    const name = packageJson.name || 'unknown';
    if (packageJson.dependencies?.['blitz']) {
      switch (argv.mode || 'dev') {
        case 'dev': {
          await runWithYarn(blitzScripts.start());
          break;
        }
        case 'prod': {
          await runWithYarn(blitzScripts.startProduction());
          break;
        }
        case 'docker': {
          await runWithYarn(blitzScripts.startDocker(name));
          break;
        }
        default: {
          throw new Error(`Unknown start mode: ${argv.mode}`);
        }
      }
    }
  },
};
