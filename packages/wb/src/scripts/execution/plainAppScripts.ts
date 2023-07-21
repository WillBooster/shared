import { dockerScripts } from '../dockerScripts.js';

import { ExecutionScripts } from './executionScripts.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class PlainAppScripts extends ExecutionScripts {
  constructor() {
    super();
  }

  override start(watch?: boolean, additionalArgs = ''): string {
    return `YARN build-ts run src/index.ts ${watch ? '--watch' : ''} ${additionalArgs}`;
  }

  override startDocker(additionalArgs = ''): string {
    return `${this.buildDocker()} && ${dockerScripts.stopAndStart(false, '', additionalArgs)}`;
  }

  override startProduction(_ = 8080, additionalArgs = ''): string {
    return `NODE_ENV=production yarn build && NODE_ENV=production node dist/index.js ${additionalArgs}`;
  }

  override testE2E(): string {
    return `echo 'do nothing.'`;
  }

  override testE2EDev(): string {
    return `echo 'do nothing.'`;
  }

  override testStart(): string {
    return `echo 'do nothing.'`;
  }
}

export const plainAppScripts = new PlainAppScripts();
