import { blitzScripts } from './blitzScripts.js';
import { dockerScripts } from './dockerScripts.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that `PRISMA` is replaced with `YARN prisma` or `YARN blitz prisma`
 * and `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class ExpressServerScripts {
  buildDocker(wbEnv = 'local'): string {
    return dockerScripts.buildDevImage(wbEnv);
  }

  start(watch?: boolean, additionalArgs = ''): string {
    return `YARN build-ts run src/index.ts ${watch ? '--watch' : ''} ${additionalArgs}`;
  }

  startDocker(additionalArgs = ''): string {
    return `${this.buildDocker()} && ${dockerScripts.stopAndStart(false, '', additionalArgs)}`;
  }

  startProduction(port = 8080, additionalArgs = ''): string {
    return `NODE_ENV=production; yarn build && PORT=\${PORT:-${port}} node dist/index.js ${additionalArgs}`;
  }

  testE2E({
    startCommand = `if [ -e "prisma" ]; then prisma migrate reset --force --skip-generate; fi && (${this.startProduction()})`,
  }): string {
    return `NODE_ENV=production WB_ENV=test YARN concurrently --kill-others --raw --success first
      "${startCommand} && exit 1"
      "wait-on -t 600000 -i 2000 http://127.0.0.1:8080 && vitest run tests/e2e --color --passWithNoTests"`;
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

export type HttpServerScriptsType = InstanceType<typeof ExpressServerScripts>;

export const httpServerScripts = new ExpressServerScripts();
