import type { Project } from '../../project.js';
import { SERVER_LOG_FILE } from '../../utils/log.js';
import { runtimeWithArgs } from '../../utils/runtime.js';
import type { ScriptArgv } from '../builder.js';
import { dockerScripts } from '../dockerScripts.js';

import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class PlainAppScripts extends BaseScripts {
  constructor() {
    super(false);
  }

  protected startDevProtected(_1: Project, _2: ScriptArgv): string {
    throw new Error('This method should not be called.');
  }

  override startDev(_: Project, argv: ScriptArgv): Promise<string> {
    return Promise.resolve(
      `YARN build-ts run ${argv.watch ? '--watch' : ''} src/index.ts -- ${argv.normalizedArgsText ?? ''}`
    );
  }
  override startProduction(project: Project, argv: ScriptArgv): Promise<string> {
    return Promise.resolve(
      `${project.buildCommand} && ${runtimeWithArgs} dist/index.js ${argv.normalizedArgsText ?? ''} | tee ${SERVER_LOG_FILE}`
    );
  }
  override startTest(): Promise<string> {
    return Promise.resolve(`echo 'do nothing.'`);
  }
  override startDocker(project: Project, argv: ScriptArgv): Promise<string> {
    return Promise.resolve(
      `${this.buildDocker(project, 'development')} && ${dockerScripts.stopAndStart(
        project,
        argv.normalizedDockerOptionsText ?? '',
        argv.normalizedArgsText ?? ''
      )}`
    );
  }

  override testE2EDev(): Promise<string> {
    return Promise.resolve(`echo 'do nothing.'`);
  }
  override testE2EProduction(): Promise<string> {
    return Promise.resolve(`echo 'do nothing.'`);
  }
  override testE2EDocker(): Promise<string> {
    return Promise.resolve(`echo 'do nothing.'`);
  }
  override testStart(): Promise<string> {
    return Promise.resolve(`echo 'do nothing.'`);
  }
}

export const plainAppScripts = new PlainAppScripts();
