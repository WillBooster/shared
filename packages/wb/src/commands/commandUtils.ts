import { loadEnvironmentVariables, restoreEnvironmentVariables } from '@willbooster/shared-lib-node/src';
import type { ArgumentsCamelCase, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

export function* prepareForRunningCommand(
  commandName: string,
  rootProject: Project,
  projects: Project[],
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof sharedOptionsBuilder>>>,
  loadingEnvironmentVariables = true
): Generator<Project, void, unknown> {
  for (const project of projects) {
    console.info(`Running "${commandName}" for ${project.name} ...`);

    if (project !== rootProject) {
      restoreEnvironmentVariables();
    }
    if (loadingEnvironmentVariables) {
      loadEnvironmentVariables(argv, project.dirPath);
      if (project !== rootProject) {
        loadEnvironmentVariables(argv, rootProject.dirPath);
      }
    }

    yield project;
  }
}
