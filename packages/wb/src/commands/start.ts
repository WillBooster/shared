import type { CommandModule, InferredOptionTypes } from 'yargs';

import { project } from '../project.js';
import { blitzScripts } from '../scripts/execution/blitzScripts.js';
import type { ExecutionScripts } from '../scripts/execution/executionScripts.js';
import { httpServerScripts } from '../scripts/execution/httpServerScripts.js';
import { plainAppScripts } from '../scripts/execution/plainAppScripts.js';
import { remixScripts } from '../scripts/execution/remixScripts.js';
import { runWithSpawn } from '../scripts/run.js';
import { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const builder = {
  ...sharedOptionsBuilder,
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
    const devDeps = project.packageJson.devDependencies || {};
    let scripts: ExecutionScripts;
    if (deps['blitz']) {
      scripts = blitzScripts;
    } else if (devDeps['@remix-run/dev']) {
      scripts = remixScripts;
    } else if (
      ((deps['express'] || deps['fastify']) && !deps['firebase-functions']) ||
      /EXPOSE\s+8080/.test(project.dockerfile)
    ) {
      scripts = httpServerScripts;
    } else {
      scripts = plainAppScripts;
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
