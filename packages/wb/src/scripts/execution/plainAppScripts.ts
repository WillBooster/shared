import type { Project } from '../../project.js';
import { runtimeWithArgs } from '../../utils/runtime.js';
import type { ScriptArgv } from '../builder.js';
import { toDevNull } from '../builder.js';
import { dockerScripts } from '../dockerScripts.js';

import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class PlainAppScripts extends BaseScripts {
  constructor() {
    super();
  }

  override start(_: Project, argv: ScriptArgv): string {
    return `YARN build-ts run ${argv.watch ? '--watch' : ''} src/index.ts -- ${argv.normalizedArgsText ?? ''}`;
  }

  override startDocker(project: Project, argv: ScriptArgv): string {
    return `${this.buildDocker(project)}${toDevNull(argv)} && ${dockerScripts.stopAndStart(
      project,
      false,
      argv.normalizedDockerOptionsText ?? '',
      argv.normalizedArgsText ?? ''
    )}`;
  }

  override startProduction(project: Project, argv: ScriptArgv): string {
    return `NODE_ENV=production ${project.buildCommand} && NODE_ENV=production ${runtimeWithArgs} dist/index.js ${
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
