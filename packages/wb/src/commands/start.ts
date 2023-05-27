import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { project } from '../project.js';
import { blitzScripts, BlitzScriptsType } from '../scripts/blitzScripts.js';
import { httpServerScripts, HttpServerScriptsType } from '../scripts/httpServerScripts.js';
import { runWithSpawn } from '../scripts/run.js';

const builder = {
  watch: {
    description: 'Whether to watch files',
    type: 'boolean',
  },
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

    switch (argv.mode || 'dev') {
      case 'dev':
      case 'development': {
        await runWithSpawn(scripts.start(argv.watch));
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
