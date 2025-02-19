import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';
import { prismaScripts } from '../prismaScripts.js';

import type { TestE2EDevOptions, TestE2EOptions } from './baseScripts.js';
import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing Next.js commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class NextScripts extends BaseScripts {
  constructor() {
    super();
  }

  override start(project: Project, argv: ScriptArgv): string {
    return `YARN concurrently --raw --kill-others-on-fail
      "next dev --turbopack ${argv.normalizedArgsText ?? ''}"
      "${this.waitAndOpenApp(project, argv)}"`;
  }

  override startProduction(project: Project, argv: ScriptArgv, port: number): string {
    return `NODE_ENV=production YARN concurrently --raw --kill-others-on-fail
      "${[
        ...(project.hasPrisma ? [prismaScripts.seed(project)] : []),
        project.buildCommand,
        `PORT=${port} pm2-runtime start ${project.findFile('ecosystem.config.cjs')} ${argv.normalizedArgsText ?? ''}`,
      ].join(' && ')}"
      "${this.waitAndOpenApp(project, argv, port)}"`;
  }

  override testE2E(project: Project, argv: TestArgv, options: TestE2EOptions): string {
    return super.testE2E(project, argv, {
      playwrightArgs: options.playwrightArgs,
      prismaDirectory: 'db',
      startCommand:
        options.startCommand ??
        [
          ...(project.hasPrisma ? [prismaScripts.reset(project)] : []),
          project.buildCommand,
          `pm2-runtime start ${project.findFile('ecosystem.config.cjs')}`,
        ].join(' && '),
    });
  }

  override testE2EDev(
    project: Project,
    argv: TestArgv,
    { startCommand = 'next dev --turbopack -p 8080' }: TestE2EDevOptions
  ): string {
    return super.testE2EDev(project, argv, { startCommand });
  }

  override testStart(project: Project, argv: ScriptArgv): string {
    return `WB_ENV=${process.env.WB_ENV} YARN concurrently --kill-others --raw --success first "next dev --turbopack" "${this.waitApp(project, argv)}"`;
  }
}

export const nextScripts = new NextScripts();
