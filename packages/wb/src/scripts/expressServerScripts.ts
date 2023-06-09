import { dockerScripts } from './dockerScripts.js';
import { WebServerScripts } from './webServerScripts.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class ExpressServerScripts extends WebServerScripts {
  constructor() {
    super();
  }

  start(watch?: boolean, additionalArgs = ''): string {
    return `YARN build-ts run src/index.ts ${watch ? '--watch' : ''} ${additionalArgs}`;
  }

  override startDocker(additionalArgs = ''): string {
    return `${this.buildDocker()} && ${dockerScripts.stopAndStart(false, '', additionalArgs)}`;
  }

  startProduction(port = 8080, additionalArgs = ''): string {
    return `NODE_ENV=production; yarn build && PORT=\${PORT:-${port}} node dist/index.js ${additionalArgs}`;
  }

  override testE2E({
    startCommand = `if [ -e "prisma" ]; then prisma migrate reset --force --skip-generate; fi && (${this.startProduction()})`,
  }): string {
    return `NODE_ENV=production WB_ENV=test YARN concurrently --kill-others --raw --success first
      "${startCommand} && exit 1"
      "wait-on -t 600000 -i 2000 http://127.0.0.1:8080 && vitest run tests/e2e --color --passWithNoTests"`;
  }

  testStart(): string {
    return `YARN concurrently --kill-others --raw --success first "${this.start()}" "${this.waitApp()}"`;
  }
}

export type HttpServerScriptsType = InstanceType<typeof ExpressServerScripts>;

export const httpServerScripts = new ExpressServerScripts();
