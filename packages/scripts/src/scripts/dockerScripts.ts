class DockerScripts {
  buildDevImage(name: string, wbEnv = 'local'): string {
    return `yarn wb optimizeForDockerBuild --outside
    && yarn retry -n 3 -- docker build -t ${name}
        --build-arg ARCH=$([ $(uname -m) = 'arm64' ] && echo arm64 || echo amd64)
        --build-arg WB_ENV=${wbEnv}
        --build-arg WB_VERSION=dev .`;
  }
  stopAndStart(name: string, unbuffer = false, additionalArgs = ''): string {
    return `${this.stop(name)} && ${unbuffer ? 'unbuffer ' : ''}${this.start(name, additionalArgs)}`;
  }
  start(name: string, additionalArgs = ''): string {
    return `docker run --rm -it -p 8080:8080 ${additionalArgs} --name ${name} ${name}`;
  }

  stop(name: string): string {
    return `echo $(docker rm -f $(docker container ls -q -f name=${name}) 2> /dev/null)`;
  }

  stopAll(): string {
    return `echo $(docker rm -f $(docker ps -q) 2> /dev/null)`;
  }
}

export const dockerScripts = new DockerScripts();
