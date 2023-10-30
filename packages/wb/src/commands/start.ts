import type { CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findAllProjects } from '../project.js';
import { normalizeArgs, scriptOptionsBuilder } from '../scripts/builder.js';
import type { BaseExecutionScripts } from '../scripts/execution/baseExecutionScripts.js';
import { blitzScripts } from '../scripts/execution/blitzScripts.js';
import { httpServerScripts } from '../scripts/execution/httpServerScripts.js';
import { nextScripts } from '../scripts/execution/nextScripts.js';
import { plainAppScripts } from '../scripts/execution/plainAppScripts.js';
import { remixScripts } from '../scripts/execution/remixScripts.js';
import { runWithSpawn } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const builder = {
  ...scriptOptionsBuilder,
  mode: {
    description: 'Start mode: dev[elopment] (default) | staging | docker',
    type: 'string',
    alias: 'm',
  },
} as const;

export const startCommand: CommandModule<unknown, InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>> = {
  command: 'start [args..]',
  describe: 'Start app',
  builder,
  async handler(argv) {
    normalizeArgs(argv);

    const projects = await findAllProjects(argv);
    if (!projects) return;

    for (const project of projects.all) {
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
      } else if (deps['build-ts'] || devDeps['build-ts']) {
        scripts = plainAppScripts;
      } else {
        continue;
      }
      console.info(`Running "start" for ${project.name} ...`);

      switch (argv.mode || 'dev') {
        case 'dev':
        case 'development': {
          const prefix = configureEnvironmentVariables(project, deps, 'development');
          await runWithSpawn(`${prefix}${scripts.start(project, argv)}`, project, argv);
          break;
        }
        case 'staging': {
          const prefix = configureEnvironmentVariables(project, deps, 'staging');
          await runWithSpawn(`${prefix}${scripts.startProduction(project, argv, 8080)}`, project, argv);
          break;
        }
        case 'docker': {
          const prefix = configureEnvironmentVariables(project, deps, 'staging');
          await runWithSpawn(`${prefix}${scripts.startDocker(project, argv)}`, project, argv);
          break;
        }
        default: {
          throw new Error(`Unknown start mode: ${argv.mode}`);
        }
      }
    }
  },
};

function configureEnvironmentVariables(project: Project, deps: Partial<Record<string, string>>, wbEnv: string): string {
  project.env.WB_ENV ||= wbEnv;
  let prefix = `WB_ENV=${project.env.WB_ENV} `;
  if (deps['next']) {
    project.env.NEXT_PUBLIC_WB_ENV = project.env.WB_ENV;
    prefix += `NEXT_PUBLIC_WB_ENV=${project.env.WB_ENV} `;
  }
  return prefix;
}
