import { prismaScripts } from './prismaScripts.js';
import { WebServerScripts } from './webServerScripts.js';

/**
 * A collection of scripts for executing Blitz.js commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class BlitzScripts extends WebServerScripts {
  constructor() {
    super();
  }

  start(watch?: boolean, additionalArgs = ''): string {
    return `YARN concurrently --raw --kill-others-on-fail
      "blitz dev ${additionalArgs}"
      "${this.waitAndOpenApp()}"`;
  }

  startProduction(port = 8080, additionalArgs = ''): string {
    return `NODE_ENV=production YARN concurrently --raw --kill-others-on-fail
      "${prismaScripts.reset()} && yarn build && PORT=${port} pm2-runtime start ecosystem.config.cjs ${additionalArgs}"
      "${this.waitAndOpenApp(port)}"`;
  }

  override testE2E({
    playwrightArgs = 'test tests/e2e',
    startCommand = `${prismaScripts.reset()} && yarn build && PORT=8080 pm2-runtime start ecosystem.config.cjs`,
  }): string {
    return super.testE2E({ playwrightArgs, prismaDirectory: 'db', startCommand });
  }

  testStart(): string {
    return `YARN concurrently --kill-others --raw --success first "blitz dev" "${this.waitApp()}"`;
  }
}

export type BlitzScriptsType = InstanceType<typeof BlitzScripts>;

export const blitzScripts = new BlitzScripts();
