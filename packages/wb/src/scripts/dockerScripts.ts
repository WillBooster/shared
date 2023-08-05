import path from 'node:path';

import { project } from '../project.js';
import { spawnSyncOnExit } from '../utils.js';

/**
 * A collection of scripts for executing Docker commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class DockerScripts {
  buildDevImage(wbEnv = 'local'): string {
    // e.g. coding-booster uses `"docker/build/prepare": "touch drill-users.csv",`
    const prefix = project.dockerPackageJson.scripts?.['docker/build/prepare']
      ? 'yarn run docker/build/prepare && '
      : '';
    return `cd ${path.dirname(project.dockerfilePath)}
    && ${prefix}YARN wb optimizeForDockerBuild --outside
    && YARN wb retry -- docker build -t ${project.name}
        --build-arg ARCH=$([ $(uname -m) = 'arm64' ] && echo arm64 || echo amd64)
        --build-arg WB_ENV=${wbEnv}
        --build-arg WB_VERSION=dev .`;
  }
  stopAndStart(unbuffer = false, additionalOptions = '', additionalArgs = ''): string {
    return `${this.stop()} && ${unbuffer ? 'unbuffer ' : ''}${this.start(additionalOptions, additionalArgs)}`;
  }
  start(additionalOptions = '', additionalArgs = ''): string {
    spawnSyncOnExit(this.stop());
    let mount = '-v ~/.yarn/berry:/root/.yarn/berry';
    if (process.platform === 'darwin') {
      mount += ' -v ~/Library/Caches/pypoetry:/root/.cache/pypoetry';
    } else if (process.platform === 'linux') {
      mount += ' -v ~/.cache/pypoetry:/root/.cache/pypoetry';
    }
    return `docker run --rm -it -p 8080:8080 ${mount} --name ${project.name} ${additionalOptions} ${project.name} ${additionalArgs}`;
  }

  stop(): string {
    return `true $(docker rm -f $(docker container ls -q -f name=${project.name}) 2> /dev/null)`;
  }

  stopAll(): string {
    return `true $(docker rm -f $(docker ps -q) 2> /dev/null)`;
  }
}

export const dockerScripts = new DockerScripts();
