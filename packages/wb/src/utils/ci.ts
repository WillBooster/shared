import type { Project } from '../project.js';

export function isCI(ciEnv: string | undefined): boolean {
  return isTruthyEnvValue(ciEnv);
}

export function isDockerEnabled(project: Pick<Project, 'env'>): boolean {
  return isTruthyEnvValue(project.env.WB_DOCKER);
}

function isTruthyEnvValue(value: string | undefined): boolean {
  return !!value && value !== '0' && value !== 'false';
}
