import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';
import { prismaScripts } from '../prismaScripts.js';

import type { TestE2EDevOptions, TestE2EOptions } from './baseScripts.js';
import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing Blitz.js commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class BlitzScripts extends BaseScripts {
  constructor() {
    super();
  }

  override start(project: Project, argv: ScriptArgv): string {
    const appEnv = project.env.WB_ENV ? `APP_ENV=${project.env.WB_ENV} ` : '';
    return `${appEnv}YARN concurrently --raw --kill-others-on-fail
      "blitz dev ${argv.normalizedArgsText ?? ''}"
      "${this.waitAndOpenApp(project, argv)}"`;
  }

  override startProduction(project: Project, argv: ScriptArgv, port: number): string {
    const appEnv = project.env.WB_ENV ? `APP_ENV=${project.env.WB_ENV} ` : '';
    return `${appEnv}NODE_ENV=production YARN concurrently --raw --kill-others-on-fail
      "${prismaScripts.reset(project)} && ${project.buildCommand} && PORT=${port} pm2-runtime start ${project.findFile(
        'ecosystem.config.cjs'
      )} ${argv.normalizedArgsText ?? ''}"
      "${this.waitAndOpenApp(project, argv, port)}"`;
  }

  override testE2E(
    project: Project,
    argv: TestArgv,
    {
      playwrightArgs,
      startCommand = `${prismaScripts.reset(project)} && ${
        project.buildCommand
      } && pm2-runtime start ${project.findFile('ecosystem.config.cjs')}`,
    }: TestE2EOptions
  ): string {
    return super.testE2E(project, argv, {
      playwrightArgs,
      prismaDirectory: 'db',
      startCommand,
    });
  }

  override testE2EDev(
    project: Project,
    argv: TestArgv,
    { playwrightArgs, startCommand = 'blitz dev -p 8080' }: TestE2EDevOptions
  ): string {
    return super.testE2EDev(project, argv, { playwrightArgs, startCommand });
  }

  override testStart(project: Project, argv: ScriptArgv): string {
    return `WB_ENV=${process.env.WB_ENV} YARN concurrently --kill-others --raw --success first "blitz dev" "${this.waitApp(project, argv)}"`;
  }
}

export const blitzScripts = new BlitzScripts();
