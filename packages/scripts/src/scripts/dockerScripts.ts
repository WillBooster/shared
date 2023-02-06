import path from 'node:path';

class DockerScripts {
  buildDocker(name: string): string {
    return `yarn wb optimizeForDockerBuild --outside
    && yarn retry -n 3 -- docker build -t ${name}
        --build-arg ARCH=$([ $(uname -m) = 'arm64' ] && echo arm64 || echo amd64)
        --build-arg WB_ENV=local
        --build-arg VERSION=dev .`;
  }
  stopAndStartDocker(name: string): string {
    return `${this.stopDocker(name)} && ${this.startDocker(name)}`;
  }
  startDocker(name: string): string {
    return `docker run --rm --it -p 8080:8080 -v '${path.resolve()}/db/mount':/app/db/mount --name ${name} ${name}`;
  }

  stopDocker(name: string): string {
    return `echo $(docker rm -f $(docker container ls -q -f name=${name}) 2> /dev/null)`;
  }

  stopAllDocker(): string {
    return `echo $(docker rm -f $(docker ps -q) 2> /dev/null)`;
  }
}

export const dockerScripts = new DockerScripts();
