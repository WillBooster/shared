import { dockerScripts } from './dockerScripts.js';

class BlitzScripts {
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
        "${dockerScripts.stopAndStart(name, false)}"
        "${blitzScripts.waitAndOpenApp(8080)}"`;
  }

  startProduction(port = 8080): string {
    return `NODE_ENV=production; yarn db:setup && yarn build && yarn blitz start -p \${PORT:-${port}}`;
  }

  testE2E({ playwrightArgs = 'test tests/e2e', startCommand = this.startProduction() }): string {
    return `APP_ENV=production WB_ENV=test yarn dotenv -e .env.production -- concurrently --kill-others --raw --success first
      "rm -Rf db/mount && ${startCommand}"
      "wait-on -t 600000 -i 2000 http://127.0.0.1:8080 && playwright ${playwrightArgs}"`;
  }

  testStart(): string {
    return `yarn concurrently --kill-others --raw --success first "blitz dev" "${this.waitApp()}"`;
  }

  testUnit(): string {
    // Since this command is referred to from other commands, we have to use "vitest run".
    return `yarn vitest run tests/unit --color`;
  }

  waitApp(port = 3000): string {
    return `wait-on -t 10000 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 500 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 1000 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 2000 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 20000 -i 4000 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 60000 -i 5000 http://127.0.0.1:${port}`;
  }

  waitAndOpenApp(port = 3000): string {
    return `${this.waitApp(port)} && open-cli http://localhost:${port}`;
  }
}

export type BlitzScriptsType = InstanceType<typeof BlitzScripts>;

export const blitzScripts = new BlitzScripts();
