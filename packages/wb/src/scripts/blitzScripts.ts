import { dockerScripts } from './dockerScripts.js';
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
    // Add NODE_ENV=production only to ${prismaScripts.reset()},
    // since NODE_ENV=production is set by default in "blitz build" and "blitz start".
    // Note: `NODE_ENV=production; yarn blitz db seed` does not work, but `NODE_ENV=production yarn blitz db seed` works.
    return `${prismaScripts.reset(
      'NODE_ENV=production '
    )} && yarn build && YARN blitz start -p \${PORT:-${port}} ${additionalArgs}`;
  }

  testE2E({ playwrightArgs = 'test tests/e2e', startCommand = this.startProduction() }): string {
    // `playwright` must work, but it doesn't work on a project depending on `artillery-engine-playwright`.
    // So we use `yarn playwright` instead of `playwright`.
    return `APP_ENV=production WB_ENV=test YARN dotenv -c production -- concurrently --kill-others --raw --success first
      "rm -Rf db/mount && ${startCommand} && exit 1"
      "wait-on -t 600000 -i 2000 http://127.0.0.1:8080 && yarn playwright ${playwrightArgs}"`;
  }

  testStart(): string {
    return `YARN concurrently --kill-others --raw --success first "blitz dev" "${this.waitApp()}"`;
  }
}

export type BlitzScriptsType = InstanceType<typeof BlitzScripts>;

export const blitzScripts = new BlitzScripts();
