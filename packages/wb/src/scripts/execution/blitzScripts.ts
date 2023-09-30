import { project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';
import { prismaScripts } from '../prismaScripts.js';

import type { TestE2EDevOptions, TestE2EOptions } from './baseExecutionScripts.js';
import { BaseExecutionScripts } from './baseExecutionScripts.js';

/**
 * A collection of scripts for executing Blitz.js commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class BlitzScripts extends BaseExecutionScripts {
  constructor() {
    super();
  }

  override start(argv: ScriptArgv): string {
    const appEnv = process.env.WB_ENV ? `APP_ENV=${process.env.WB_ENV} ` : '';
    return `${appEnv}YARN concurrently --raw --kill-others-on-fail
      "blitz dev ${argv.normalizedArgsText ?? ''}"
      "${this.waitAndOpenApp(argv)}"`;
  }

  override startProduction(argv: ScriptArgv, port: number): string {
    const appEnv = process.env.WB_ENV ? `APP_ENV=${process.env.WB_ENV} ` : '';
    return `${appEnv}NODE_ENV=production YARN concurrently --raw --kill-others-on-fail
      "${prismaScripts.reset()} && ${project.getBuildCommand(
        argv
      )} && PORT=${port} pm2-runtime start ecosystem.config.cjs ${argv.normalizedArgsText ?? ''}"
      "${this.waitAndOpenApp(argv, port)}"`;
  }

  override testE2E(
    argv: ScriptArgv,
    {
      playwrightArgs = 'test tests/e2e',
      startCommand = `${prismaScripts.reset()} && ${project.getBuildCommand(
        argv
      )} && pm2-runtime start ecosystem.config.cjs`,
    }: TestE2EOptions
  ): string {
    return super.testE2E(argv, {
      playwrightArgs,
      prismaDirectory: 'db',
      startCommand,
    });
  }

  override testE2EDev(
    argv: ScriptArgv,
    { playwrightArgs = 'test tests/e2e', startCommand = 'blitz dev -p 8080' }: TestE2EDevOptions
  ): string {
    return super.testE2EDev(argv, { playwrightArgs, startCommand });
  }

  override testStart(argv: ScriptArgv): string {
    return `YARN concurrently --kill-others --raw --success first "blitz dev" "${this.waitApp(argv)}"`;
  }
}

export const blitzScripts = new BlitzScripts();
