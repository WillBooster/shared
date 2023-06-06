import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { project } from '../project.js';
import type { BlitzScriptsType } from '../scripts/blitzScripts.js';
import { blitzScripts } from '../scripts/blitzScripts.js';
import type { HttpServerScriptsType } from '../scripts/httpServerScripts.js';
import { httpServerScripts } from '../scripts/httpServerScripts.js';
import { runWithSpawn } from '../scripts/run.js';
import { sharedOptions } from '../sharedOptions.js';

const builder = {
  ...sharedOptions,
  watch: {
    description: 'Whether to watch files',
    type: 'boolean',
  },
  mode: {
    description: 'Start mode: dev[elopment] (default) | prod[uction] | docker',
    type: 'string',
    alias: 'm',
  },
  args: {
    description: 'Arguments text for start command',
    type: 'string',
    alias: 'a',
  },
} as const;

export const startCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'start',
  describe: 'Start app',
  builder,
  async handler(argv) {
    const deps = project.packageJson.dependencies || {};
    let scripts: BlitzScriptsType | HttpServerScriptsType | undefined;
    if (deps['blitz']) {
      scripts = blitzScripts;
    } else if ((deps['express'] && !deps['firebase-functions']) || /EXPOSE\s+8080/.test(project.dockerfile)) {
      scripts = httpServerScripts;
    }
    if (!scripts) {
      console.error(chalk.red('Unable to determine the method for starting the app.'));
      return;
    }

    const argsText = argv.args ?? '';
    switch (argv.mode || 'dev') {
      case 'dev':
      case 'development': {
        await runWithSpawn(scripts.start(argv.watch, argsText), argv);
        break;
      }
      case 'prod':
      case 'production': {
        await runWithSpawn(scripts.startProduction(8080, argsText), argv);
        break;
      }
      case 'docker': {
        await runWithSpawn(scripts.startDocker(argsText), argv);
        break;
      }
      default: {
        throw new Error(`Unknown start mode: ${argv.mode}`);
      }
    }
  },
};
