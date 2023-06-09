import { prismaScripts } from './prismaScripts.js';
import { WebServerScripts } from './webServerScripts.js';

/**
 * A collection of scripts for executing Remix commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class RemixScripts extends WebServerScripts {
  constructor() {
    super();
  }

  start(watch?: boolean, additionalArgs = ''): string {
    return `YARN concurrently --raw --kill-others-on-fail
      "dotenv -c development -- remix dev ${additionalArgs}"
      "${this.waitAndOpenApp()}"`;
  }

  startProduction(port = 8080, additionalArgs = ''): string {
    return `NODE_ENV=production YARN dotenv -c production -- concurrently --raw --kill-others-on-fail
      "${prismaScripts.reset()} && yarn build && PORT=${port} pm2-runtime start ecosystem.config.cjs ${additionalArgs}"
      "${this.waitAndOpenApp(port)}"`;
  }

  override testE2E({
    playwrightArgs = 'test tests/e2e',
    startCommand = `${prismaScripts.reset()} && yarn build && PORT=8080 pm2-runtime start ecosystem.config.cjs`,
  }): string {
    return super.testE2E({ playwrightArgs, prismaDirectory: 'prisma', startCommand });
  }

  testStart(): string {
    return `YARN concurrently --kill-others --raw --success first "dotenv -c development -- remix dev" "${this.waitApp()}"`;
  }
}

export type RemixScriptsType = InstanceType<typeof RemixScripts>;

export const remixScripts = new RemixScripts();
