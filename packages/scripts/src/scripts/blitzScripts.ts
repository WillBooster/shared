import path from 'node:path';

class BlitzScripts {
  buildDocker(name: string): string {
    return `touch gcp-sa-key.json
    && yarn wb optimizeForDockerBuild --outside
    && yarn retry -n $([ \${WB_ENV:-'?'} = 'production' ] && echo 5 || echo 0) --
      docker build -t ${name}
        --build-arg ARCH=$([ $(uname -m) = 'arm64' ] && echo arm64 || echo amd64)
        --build-arg WB_ENV=local
        --build-arg VERSION=dev .`;
  }
  startDocker(name: string): string {
    return `${blitzScripts.stopDocker(name)}
      && docker run --rm --it -p 8080:8080
        -v '${path.resolve()}/db/mount':/app/db/mount --name ${name} ${name}`;
  }

  stopDocker(name: string): string {
    return `echo $(docker rm -f $(docker container ls -q -f name=${name}) 2> /dev/null)`;
  }

  testE2E(name: string): string {
    return `APP_ENV=production dotenv -e .env.production -- concurrently --kill-others --raw --success first "rm -Rf db/mount && \${START_CMD:-yarn start-prod}" "wait-on -t 300000 -i 2000 http://127.0.0.1:8080 && playwright \${PLAYWRIGHT_ARGS:-test tests/e2e}"`;
  }

  waitApp(port = 3000): string {
    return `wait-on -t 60000 -i 2000 http://127.0.0.1:${port}`;
  }

  waitAndOpenApp(port = 3000): string {
    return `${this.waitApp(port)} && open-cli http://localhost:${port}`;
  }
}

export const blitzScripts = new BlitzScripts();
