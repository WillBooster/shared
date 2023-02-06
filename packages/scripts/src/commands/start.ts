import fs from 'node:fs/promises';
import path from 'node:path';

import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { blitzScripts } from '../scripts/blitzScripts.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import { runScript } from '../scripts/sharedScripts.js';

const builder = {
  mode: {
    description: 'Start mode: dev | prod | docker',
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
      switch (argv.mode) {
        case 'dev': {
          process.exitCode = await runScript(blitzScripts.start());
          break;
        }
        case 'prod': {
          process.exitCode = await runScript(blitzScripts.startProduction());
          break;
        }
        case 'docker': {
          process.exitCode = await runScript(blitzScripts.startDocker(name));
          break;
        }
        default: {
          throw new Error(`Unknown start mode: ${argv.mode}`);
        }
      }
    }
  },
};
