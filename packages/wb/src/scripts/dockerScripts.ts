import { spawnSync } from 'node:child_process';

import { project } from '../project.js';

/**
 * A collection of scripts for executing Docker commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class DockerScripts {
  buildDevImage(wbEnv = 'local'): string {
    const prefix = project.packageJson.scripts?.['docker/build/prepare'] ? 'yarn run docker/build/prepare && ' : '';
    return `${prefix}YARN wb optimizeForDockerBuild --outside
    && YARN retry -n 3 -- docker build -t ${project.name}
        --build-arg ARCH=$([ $(uname -m) = 'arm64' ] && echo arm64 || echo amd64)
        --build-arg WB_ENV=${wbEnv}
        --build-arg WB_VERSION=dev .`;
  }
  stopAndStart(unbuffer = false, additionalOptions = '', additionalArgs = ''): string {
    return `${this.stop()} && ${unbuffer ? 'unbuffer ' : ''}${this.start(additionalOptions, additionalArgs)}`;
  }
  start(additionalOptions = '', additionalArgs = ''): string {
    process.on('exit', () => spawnSync(this.stop(), { shell: true, stdio: 'inherit' }));
    return `docker run --rm -it -p 8080:8080 --name ${project.name} ${additionalOptions} ${project.name} ${additionalArgs}`;
  }

  stop(): string {
    return `true $(docker rm -f $(docker container ls -q -f name=${project.name}) 2> /dev/null)`;
  }

  stopAll(): string {
    return `true $(docker rm -f $(docker ps -q) 2> /dev/null)`;
  }
}

export const dockerScripts = new DockerScripts();
