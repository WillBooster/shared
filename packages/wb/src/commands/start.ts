import { loadEnvironmentVariables } from '@willbooster/shared-lib-node/src';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { project } from '../project.js';
import { normalizeArgs, scriptOptionsBuilder } from '../scripts/builder.js';
import type { BaseExecutionScripts } from '../scripts/execution/baseExecutionScripts.js';
import { blitzScripts } from '../scripts/execution/blitzScripts.js';
import { httpServerScripts } from '../scripts/execution/httpServerScripts.js';
import { nextScripts } from '../scripts/execution/nextScripts.js';
import { plainAppScripts } from '../scripts/execution/plainAppScripts.js';
import { remixScripts } from '../scripts/execution/remixScripts.js';
import { runWithSpawn } from '../scripts/run.js';

const builder = {
  ...scriptOptionsBuilder,
  mode: {
    description: 'Start mode: dev[elopment] (default) | staging | docker',
    type: 'string',
    alias: 'm',
  },
} as const;

export const startCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'start [args..]',
  describe: 'Start app',
  builder,
  async handler(argv) {
    normalizeArgs(argv);

    const deps = project.packageJson.dependencies || {};
    const devDeps = project.packageJson.devDependencies || {};
    let scripts: BaseExecutionScripts;
    if (deps['blitz']) {
      scripts = blitzScripts;
    } else if (deps['next']) {
      scripts = nextScripts;
    } else if (devDeps['@remix-run/dev']) {
      scripts = remixScripts;
    } else if (
      ((deps['express'] || deps['fastify']) && !deps['firebase-functions']) ||
      (project.hasDockerfile && /EXPOSE\s+8080/.test(project.dockerfile))
    ) {
      scripts = httpServerScripts;
    } else {
      scripts = plainAppScripts;
    }

    switch (argv.mode || 'dev') {
      case 'dev':
      case 'development': {
        process.env.WB_ENV ||= 'development';
        loadEnvironmentVariables(argv, project.dirPath);
        await runWithSpawn(`WB_ENV=${process.env.WB_ENV} ${scripts.start(argv)}`, argv);
        break;
      }
      case 'staging': {
        process.env.WB_ENV ||= 'staging';
        loadEnvironmentVariables(argv, project.dirPath);
        await runWithSpawn(`WB_ENV=${process.env.WB_ENV} ${scripts.startProduction(argv, 8080)}`, argv);
        break;
      }
      case 'docker': {
        process.env.WB_ENV ||= 'staging';
        loadEnvironmentVariables(argv, project.dirPath);
        await runWithSpawn(`WB_ENV=${process.env.WB_ENV} ${scripts.startDocker(argv)}`, argv);
        break;
      }
      default: {
        throw new Error(`Unknown start mode: ${argv.mode}`);
      }
    }
  },
};
