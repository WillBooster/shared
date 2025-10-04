import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects } from '../project.js';
import { normalizeArgs, scriptOptionsBuilder } from '../scripts/builder.js';
import type { BaseScripts } from '../scripts/execution/baseScripts.js';
import { blitzScripts } from '../scripts/execution/blitzScripts.js';
import { httpServerScripts } from '../scripts/execution/httpServerScripts.js';
import { nextScripts } from '../scripts/execution/nextScripts.js';
import { plainAppScripts } from '../scripts/execution/plainAppScripts.js';
import { remixScripts } from '../scripts/execution/remixScripts.js';
import { runWithSpawn } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

import { httpServerPackages } from './httpServerPackages.js';

const builder = {
  ...scriptOptionsBuilder,
  mode: {
    description: 'Start mode: dev[elopment] (default) | staging | docker | docker-debug | test',
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

    const projects = await findDescendantProjects(argv);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    for (const project of projects.descendants) {
      const deps = project.packageJson.dependencies ?? {};
      const devDeps = project.packageJson.devDependencies ?? {};
      let scripts: BaseScripts;
      if (deps.blitz) {
        scripts = blitzScripts;
      } else if (deps.next) {
        scripts = nextScripts;
      } else if (devDeps['@remix-run/dev']) {
        scripts = remixScripts;
      } else if (
        (httpServerPackages.some((p) => deps[p]) && !deps['firebase-functions']) ||
        (project.hasDockerfile && /EXPOSE\s+8080/.test(project.dockerfile))
      ) {
        scripts = httpServerScripts;
      } else if (deps['build-ts'] || devDeps['build-ts']) {
        scripts = plainAppScripts;
      } else {
        continue;
      }
      console.info(`Running "start" for ${project.name} ...`);

      switch (argv.mode ?? 'dev') {
        case 'dev':
        case 'development': {
          const prefix = configureEnvironmentVariables(deps, 'development');
          await runWithSpawn(`${prefix}${scripts.start(project, argv)}`, project, argv);
          break;
        }
        case 'staging': {
          const prefix = configureEnvironmentVariables(deps, 'staging');
          await runWithSpawn(`${prefix}${scripts.startProduction(project, argv, 8080)}`, project, argv);
          break;
        }
        case 'docker': {
          const prefix = configureEnvironmentVariables(deps, 'staging');
          await runWithSpawn(`${prefix}${scripts.startDocker(project, argv)}`, project, argv);
          break;
        }
        case 'docker-debug': {
          const prefix = configureEnvironmentVariables(deps, 'staging');
          argv.normalizedArgsText = `'/bin/bash'`;
          await runWithSpawn(`${prefix}${scripts.startDocker(project, argv)}`, project, argv);
          break;
        }
        case 'test': {
          const prefix = configureEnvironmentVariables(deps, 'test');
          await runWithSpawn(`${prefix}${scripts.startTest(project, argv)}`, project, argv);
          break;
        }
        default: {
          throw new Error(`Unknown start mode: ${argv.mode}`);
        }
      }
    }
  },
};

function configureEnvironmentVariables(deps: Partial<Record<string, string>>, wbEnv: string): string {
  process.env.WB_ENV ||= wbEnv;
  let prefix = `WB_ENV=${process.env.WB_ENV} `;
  if (deps.next) {
    process.env.NEXT_PUBLIC_WB_ENV = process.env.WB_ENV;
    prefix += `NEXT_PUBLIC_WB_ENV=${process.env.WB_ENV} `;
  }
  return prefix;
}
