import { project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';
import { prismaScripts } from '../prismaScripts.js';

import type { TestE2EDevOptions, TestE2EOptions } from './baseExecutionScripts.js';
import { BaseExecutionScripts } from './baseExecutionScripts.js';

/**
 * A collection of scripts for executing Remix commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class RemixScripts extends BaseExecutionScripts {
  constructor() {
    super();
  }

  override start(argv: ScriptArgv): string {
    return `YARN concurrently --raw --kill-others-on-fail
      "remix dev ${argv.normalizedArgsText ?? ''}"
      "${this.waitAndOpenApp(argv)}"`;
  }

  override startProduction(argv: ScriptArgv, port: number): string {
    return `NODE_ENV=production YARN concurrently --raw --kill-others-on-fail
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
    return super.testE2E(argv, { playwrightArgs, prismaDirectory: 'prisma', startCommand });
  }

  override testE2EDev(
    argv: ScriptArgv,
    { playwrightArgs = 'test tests/e2e', startCommand = 'remix dev' }: TestE2EDevOptions
  ): string {
    return super.testE2EDev(argv, { playwrightArgs, startCommand });
  }

  override testStart(argv: ScriptArgv): string {
    return `YARN concurrently --kill-others --raw --success first "remix dev" "${this.waitApp(argv)}"`;
  }
}

export const remixScripts = new RemixScripts();
