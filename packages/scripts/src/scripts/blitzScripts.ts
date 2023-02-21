import { PackageJson } from 'type-fest';

import { dockerScripts } from './dockerScripts.js';

class BlitzScripts {
  buildDocker(name: string, packageJson: PackageJson, wbEnv = 'local'): string {
    return dockerScripts.buildDevImage(name, packageJson, wbEnv);
  }

  start(): string {
    return `concurrently --raw --kill-others-on-fail
      "blitz dev"
      "${blitzScripts.waitAndOpenApp()}"`;
  }

  startDocker(name: string, packageJson: PackageJson): string {
    return `${this.buildDocker(name, packageJson)}
      && concurrently --raw --kill-others-on-fail
        "${dockerScripts.stopAndStart(name, false)}"
        "${blitzScripts.waitAndOpenApp(8080)}"`;
  }

  startProduction(port = 8080): string {
    // Add NODE_ENV=production only to "yarn db:setup",
    // since NODE_ENV=production is set by default in "blitz build" and "blitz start"
    return `NODE_ENV=production yarn db:setup && yarn build && blitz start -p \${PORT:-${port}}`;
  }

  testE2E({ playwrightArgs = 'test tests/e2e', startCommand = this.startProduction() }): string {
    return `APP_ENV=production WB_ENV=test dotenv -e .env.production -- concurrently --kill-others --raw --success first
      "rm -Rf db/mount && ${startCommand}"
      "wait-on -t 600000 -i 2000 http://127.0.0.1:8080 && playwright ${playwrightArgs}"`;
  }

  testStart(): string {
    return `concurrently --kill-others --raw --success first "blitz dev" "${this.waitApp()}"`;
  }

  testUnit(): string {
    // Since this command is referred to from other commands, we have to use "vitest run".
    return `vitest run tests/unit --color`;
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
