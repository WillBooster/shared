import type { Project } from '../project.js';

export function* prepareForRunningCommand(commandName: string, projects: Project[]): Generator<Project, void, unknown> {
  for (const project of projects) {
    console.info(`Running "${commandName}" for ${project.name} ...`);

    yield project;
  }
}
