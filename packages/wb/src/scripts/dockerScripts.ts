import path from 'node:path';

import type { Project } from '../project.js';
import { spawnSyncOnExit } from '../utils/process.js';

/**
 * A collection of scripts for executing Docker commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class DockerScripts {
  buildImage(project: Project, version: string): string {
    // e.g. coding-booster uses `"docker/build/prepare": "touch drill-users.csv",`
    const prefix = project.dockerPackageJson.scripts?.['docker/build/prepare']
      ? 'YARN run docker/build/prepare && '
      : '';
    const miseAgeKeySecretOption = project.env.MISE_AGE_KEY
      ? '\n        --secret id=mise_age_key,env=MISE_AGE_KEY'
      : '';
    return `cd ${path.dirname(project.findFile('Dockerfile'))}
    && ${prefix}YARN wb optimizeForDockerBuild --outside
    && YARN wb retry -- docker build -t ${project.dockerImageName}
        --build-arg ARCH=$([ $(uname -m) = 'arm64' ] && echo arm64 || echo x86_64)
        --build-arg WB_ENV=${project.env.WB_ENV}
        --build-arg WB_VERSION=${version}${miseAgeKeySecretOption} .`;
  }

  stopAndStart(project: Project, additionalOptions = '', additionalArgs = ''): string {
    return `${this.stop(project)} && ${this.start(project, additionalOptions, additionalArgs)}`;
  }

  start(project: Project, additionalOptions = '', additionalArgs = ''): string {
    spawnSyncOnExit(this.stop(project), project);
    const allocateTty = additionalArgs.includes('/bin/bash');
    const miseAgeKeyEnvOption = project.env.MISE_AGE_KEY ? '--env MISE_AGE_KEY ' : '';
    return `docker run --rm ${allocateTty ? '-it ' : ''}${miseAgeKeyEnvOption}${selectContainerEnvOptions(project)}--publish ${project.env.PORT}:8080 --name ${project.dockerImageName} ${additionalOptions} ${project.dockerImageName} ${additionalArgs}`;
  }

  stop(project: Project): string {
    return `docker rm -f ${project.dockerImageName} > /dev/null 2>&1 || true`;
  }

  stopAll(): string {
    return `true $(docker rm -f $(docker ps -q) 2> /dev/null)`;
  }
}

export const dockerScripts = new DockerScripts();

// Variables the IMAGE itself owns: a Dockerfile pins the container port (the published mapping
// targets 8080, not the host-side PORT) and the runtime mode it was built for, and before fnox the
// baked .env files lost to those `ENV` values too because process.env wins over env sources.
const IMAGE_OWNED_KEYS = new Set(['NODE_ENV', 'PORT']);

/**
 * `docker run --env KEY` options for every variable the project declares, so a container gets the
 * app's environment. Since fnox replaced the .env files that images used to bake in — the age key
 * that decrypts them must never enter a container — a container would otherwise start with no
 * configuration at all. Only NAMES are passed: docker then forwards each value from wb's own
 * environment, keeping secrets out of the command line (visible in `ps` output and CI logs).
 */
function selectContainerEnvOptions(project: Project): string {
  const options = selectContainerEnvKeys(project.declaredEnvKeys, project.env).map((key) => `--env ${key}`);
  return options.length > 0 ? `${options.join(' ')} ` : '';
}

/** The declared variables to forward into a container, sorted for a stable command. */
export function selectContainerEnvKeys(
  declaredEnvKeys: ReadonlySet<string>,
  env: Record<string, string | undefined>
): string[] {
  return [...declaredEnvKeys]
    .filter((key) => !IMAGE_OWNED_KEYS.has(key) && env[key] !== undefined)
    .toSorted((a, b) => a.localeCompare(b));
}
