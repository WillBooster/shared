import { blitzScripts } from './blitzScripts.js';
import { dockerScripts } from './dockerScripts.js';

class ExpressScripts {
  buildDocker(wbEnv = 'local'): string {
    return dockerScripts.buildDevImage(wbEnv);
  }

  start(): string {
    return `YARN build-ts run src/index.ts`;
  }

  startDocker(): string {
    return `${this.buildDocker()} && ${dockerScripts.stopAndStart(false)}`;
  }

  startProduction(port = 8080): string {
    return `NODE_ENV=production; yarn build && PORT=\${PORT:-${port}} node dist/index.js`;
  }

  testE2E({
    startCommand = `if [ -e "prisma" ]; then prisma migrate reset --force --skip-generate; fi && ${this.startProduction()}`,
  }): string {
    console.log('testE2E', startCommand);
    return `NODE_ENV=production WB_ENV=test YARN concurrently --kill-others --raw --success first
      "${startCommand}"
      "wait-on -t 600000 -i 2000 http://127.0.0.1:8080 && vitest run tests/e2e --color"`;
  }

  testStart(): string {
    return `YARN concurrently --kill-others --raw --success first "${this.start()}" "${this.waitApp()}"`;
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
