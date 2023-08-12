import { project } from '../../project.js';
import { prismaScripts } from '../prismaScripts.js';

import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing Blitz.js commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class BlitzScripts extends BaseScripts {
  constructor() {
    super();
  }

  override start(watch?: boolean, additionalArgs = ''): string {
    return `YARN concurrently --raw --kill-others-on-fail
      "blitz dev ${additionalArgs}"
      "${this.waitAndOpenApp()}"`;
  }

  override startProduction(port = 8080, additionalArgs = ''): string {
    return `NODE_ENV=production YARN concurrently --raw --kill-others-on-fail
      "${prismaScripts.reset()} && ${
        project.buildCommand
      } && PORT=${port} pm2-runtime start ecosystem.config.cjs ${additionalArgs}"
      "${this.waitAndOpenApp(port)}"`;
  }

  override testE2E({
    playwrightArgs = 'test tests/e2e',
    startCommand = `${prismaScripts.reset()} && ${project.buildCommand} && pm2-runtime start ecosystem.config.cjs`,
  }): string {
    return super.testE2E({ playwrightArgs, prismaDirectory: 'db', startCommand });
  }

  override testE2EDev({ playwrightArgs = 'test tests/e2e', startCommand = 'blitz dev -p 8080' }): string {
    return super.testE2EDev({ playwrightArgs, startCommand });
  }

  override testStart(): string {
    return `YARN concurrently --kill-others --raw --success first "blitz dev" "${this.waitApp()}"`;
  }
}

export const blitzScripts = new BlitzScripts();
