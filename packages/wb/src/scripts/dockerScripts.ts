import path from 'node:path';

import type { Project } from '../project.js';
import { spawnSyncOnExit } from '../utils/process.js';

/**
 * A collection of scripts for executing Docker commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class DockerScripts {
  buildDevImage(project: Project, version: string): string {
    // e.g. coding-booster uses `"docker/build/prepare": "touch drill-users.csv",`
    const prefix = project.dockerPackageJson.scripts?.['docker/build/prepare']
      ? 'yarn run docker/build/prepare && '
      : '';
    return `cd ${path.dirname(project.findFile('Dockerfile'))}
    && ${prefix}YARN wb optimizeForDockerBuild --outside
    && YARN wb retry -- docker build -t ${project.dockerImageName}
        --build-arg ARCH=$([ $(uname -m) = 'arm64' ] && echo arm64 || echo amd64)
        --build-arg WB_ENV=${project.env.WB_ENV}
        --build-arg WB_VERSION=${version} .`;
  }
  stopAndStart(project: Project, unbuffer = false, additionalOptions = '', additionalArgs = ''): string {
    return `${this.stop(project)} && ${unbuffer ? 'unbuffer ' : ''}${this.start(
      project,
      additionalOptions,
      additionalArgs
    )}`;
  }
  start(project: Project, additionalOptions = '', additionalArgs = ''): string {
    spawnSyncOnExit(this.stop(project), project);
    return `docker run --rm -it -p 8080:8080 --name ${project.dockerImageName} ${additionalOptions} ${project.dockerImageName} ${additionalArgs}`;
  }

  stop(project: Project): string {
    return `true $(docker rm -f $(docker container ls -q -f name=${project.dockerImageName}) 2> /dev/null)`;
  }

  stopAll(): string {
    return `true $(docker rm -f $(docker ps -q) 2> /dev/null)`;
  }
}

export const dockerScripts = new DockerScripts();
