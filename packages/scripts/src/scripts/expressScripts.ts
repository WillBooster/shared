import { PackageJson } from 'type-fest';

import { blitzScripts } from './blitzScripts.js';
import { dockerScripts } from './dockerScripts.js';

class ExpressScripts {
  buildDocker(name: string, packageJson: PackageJson, wbEnv = 'local'): string {
    return dockerScripts.buildDevImage(name, packageJson, wbEnv);
  }

  start(): string {
    return `build-ts run src/index.ts`;
  }

  startDocker(name: string, packageJson: PackageJson): string {
    return `${this.buildDocker(name, packageJson)} && ${dockerScripts.stopAndStart(name, false)}`;
  }

  startProduction(port = 8080): string {
    return `NODE_ENV=production; yarn build && PORT=\${PORT:-${port}} node dist/index.js`;
  }

  testE2E({ startCommand = `yarn prisma migrate reset --force --skip-generate && ${this.startProduction()}` }): string {
    return `NODE_ENV=production WB_ENV=test yarn concurrently --kill-others --raw --success first
      "${startCommand}"
      "wait-on -t 600000 -i 2000 http://127.0.0.1:8080 && vitest run tests/e2e --color"`;
  }

  testStart(): string {
    return `yarn concurrently --kill-others --raw --success first "${this.start()}" "${this.waitApp()}"`;
  }

  testUnit(): string {
    return blitzScripts.testUnit();
  }

  private waitApp(port = 3000): string {
    return blitzScripts.waitApp(port);
  }
}

export type ExpressScriptsType = InstanceType<typeof ExpressScripts>;

export const expressScripts = new ExpressScripts();
