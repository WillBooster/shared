import type { CommandModule, InferredOptionTypes } from 'yargs';

import { project } from '../project.js';
import { blitzScripts, BlitzScriptsType } from '../scripts/blitzScripts.js';
import { expressScripts, ExpressScriptsType } from '../scripts/expressScripts.js';
import { runWithSpawn } from '../scripts/run.js';

const builder = {
  mode: {
    description: 'Start mode: dev[elopment] (default) | prod[uction] | docker',
    type: 'string',
    alias: 'm',
  },
} as const;

export const startCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'start',
  describe: 'Start app',
  builder,
  async handler(argv) {
    const deps = project.packageJson.dependencies || {};
    let scripts: BlitzScriptsType | ExpressScriptsType | undefined;
    if (deps['blitz']) {
      scripts = blitzScripts;
    } else if (deps['express'] && !deps['firebase-functions']) {
      scripts = expressScripts;
    }
    if (!scripts) return;

    switch (argv.mode || 'dev') {
      case 'dev':
      case 'development': {
        await runWithSpawn(scripts.start());
        break;
      }
      case 'prod':
      case 'production': {
        await runWithSpawn(scripts.startProduction());
        break;
      }
      case 'docker': {
        await runWithSpawn(scripts.startDocker());
        break;
      }
      default: {
        throw new Error(`Unknown start mode: ${argv.mode}`);
      }
    }
  },
};
