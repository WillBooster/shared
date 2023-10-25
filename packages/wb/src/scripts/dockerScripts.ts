import path from 'node:path';

import { spawnSyncOnExit } from '../processUtils.js';
import type { Project } from '../project.js';

/**
 * A collection of scripts for executing Docker commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class DockerScripts {
  buildDevImage(project: Project): string {
    // e.g. coding-booster uses `"docker/build/prepare": "touch drill-users.csv",`
    const prefix = project.dockerPackageJson.scripts?.['docker/build/prepare']
      ? 'yarn run docker/build/prepare && '
      : '';
    return `cd ${path.dirname(project.findFile('Dockerfile'))}
    && ${prefix}YARN wb optimizeForDockerBuild --outside
    && YARN wb retry -- docker build -t ${project.nameWithoutNamespace}
        --build-arg ARCH=$([ $(uname -m) = 'arm64' ] && echo arm64 || echo amd64)
        --build-arg WB_ENV=${process.env.WB_ENV}
        --build-arg WB_VERSION=dev .`;
  }
  stopAndStart(project: Project, unbuffer = false, additionalOptions = '', additionalArgs = ''): string {
    return `${this.stop(project)} && ${unbuffer ? 'unbuffer ' : ''}${this.start(
      project,
      additionalOptions,
      additionalArgs
    )}`;
  }
  start(project: Project, additionalOptions = '', additionalArgs = ''): string {
    spawnSyncOnExit(this.stop(project));
    return `docker run --rm -it -p 8080:8080 --name ${project.nameWithoutNamespace} ${additionalOptions} ${project.nameWithoutNamespace} ${additionalArgs}`;
  }

  stop(project: Project): string {
    return `true $(docker rm -f $(docker container ls -q -f name=${project.nameWithoutNamespace}) 2> /dev/null)`;
  }

  stopAll(): string {
    return `true $(docker rm -f $(docker ps -q) 2> /dev/null)`;
  }
}

export const dockerScripts = new DockerScripts();
