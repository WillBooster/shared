import path from 'node:path';

import { dockerScripts } from './dockerScripts.js';

class BlitzScripts {
  get dockerRunAdditionalArgs(): string {
    return `-v '${path.resolve()}/db/mount':/app/db/mount`;
  }

  buildDocker(name: string, wbEnv = 'local'): string {
    return `touch gcp-sa-key.json && ${dockerScripts.buildDevImage(name, wbEnv)}`;
  }

  start(): string {
    return `yarn concurrently --raw --kill-others-on-fail
      "blitz dev"
      "${blitzScripts.waitAndOpenApp()}"`;
  }

  startDocker(name: string): string {
    return `${this.buildDocker(name)}
      && yarn concurrently --raw --kill-others-on-fail
        "${dockerScripts.stopAndStart(name, this.dockerRunAdditionalArgs)}"
        "${blitzScripts.waitAndOpenApp(8080)}"`;
  }

  startProduction(port = 8080): string {
    return `NODE_ENV=production; yarn db:setup && yarn build && yarn blitz start -p \${PORT:-${port}}`;
  }

  testE2E({ playwrightArgs = 'test tests/e2e', startCommand = this.startProduction() }): string {
    return `APP_ENV=production yarn dotenv -e .env.production -- concurrently --kill-others --raw --success first
      "rm -Rf db/mount && WB_ENV=test ${startCommand}"
      "wait-on -t 600000 -i 2000 http://127.0.0.1:8080 && playwright ${playwrightArgs}"`;
  }

  testStart(): string {
    return `yarn concurrently --kill-others --raw --success first "blitz dev" "${this.waitApp()}"`;
  }

  testUnit(): string {
    return `yarn vitest run tests/unit`;
  }

  private waitApp(port = 3000): string {
    return `wait-on -t 10000 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 500 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 1000 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 2000 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 20000 -i 4000 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 60000 -i 5000 http://127.0.0.1:${port}`;
  }

  private waitAndOpenApp(port = 3000): string {
    return `${this.waitApp(port)} && open-cli http://localhost:${port}`;
  }
}

export const blitzScripts = new BlitzScripts();
