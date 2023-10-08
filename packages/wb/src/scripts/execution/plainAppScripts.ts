import { project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';
import { dockerScripts } from '../dockerScripts.js';

import { BaseExecutionScripts } from './baseExecutionScripts.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class PlainAppScripts extends BaseExecutionScripts {
  constructor() {
    super();
  }

  override start(argv: ScriptArgv): string {
    return `YARN build-ts run src/index.ts ${argv.watch ? '--watch' : ''} -- ${argv.normalizedArgsText ?? ''}`;
  }

  override startDocker(argv: ScriptArgv): string {
    return `${this.buildDocker()} && ${dockerScripts.stopAndStart(
      false,
      argv.normalizedDockerArgsText ?? '',
      argv.normalizedArgsText ?? ''
    )}`;
  }

  override startProduction(argv: ScriptArgv): string {
    return `NODE_ENV=production ${project.getBuildCommand(argv)} && NODE_ENV=production node dist/index.js ${
      argv.normalizedArgsText ?? ''
    }`;
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
