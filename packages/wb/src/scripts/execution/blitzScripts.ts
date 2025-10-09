import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import { findAvailablePort } from '../../utils/findPort.js';
import type { ScriptArgv } from '../builder.js';
import { toDevNull } from '../builder.js';
import { prismaScripts } from '../prismaScripts.js';

import type { TestE2EDevOptions, TestE2EOptions } from './baseScripts.js';
import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing Blitz.js commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class BlitzScripts extends BaseScripts {
  override start(project: Project, argv: ScriptArgv): string {
    const appEnv = project.env.WB_ENV ? `APP_ENV=${project.env.WB_ENV} ` : '';
    return `${appEnv}YARN concurrently --raw --kill-others-on-fail
      "blitz dev ${argv.normalizedArgsText ?? ''}"
      "${this.waitAndOpenApp(project, argv)}"`;
  }

  override startProduction(project: Project, argv: ScriptArgv, port: number): string {
    const appEnv = project.env.WB_ENV ? `APP_ENV=${project.env.WB_ENV} ` : '';
    return `${appEnv}NODE_ENV=production YARN concurrently --raw --kill-others-on-fail
      "${[
        prismaScripts.migrate(project),
        project.buildCommand,
        `PORT=${port} pm2-runtime start ${project.findFile('ecosystem.config.cjs')} ${argv.normalizedArgsText ?? ''}`,
      ].join(' && ')}"
      "${this.waitAndOpenApp(project, argv, port)}"`;
  }

  override startTest(project: Project, argv: ScriptArgv): string {
    const port = Number(process.env.PORT) || 8080;
    return `YARN concurrently --raw --kill-others-on-fail
      "${[
        ...prismaScripts.reset(project).split('&&'),
        project.buildCommand,
        `pm2-runtime start ${project.findFile('ecosystem.config.cjs')}`,
      ]
        .map((c) => `${c.trim()}${toDevNull(argv)}`)
        .join(' && ')}"
      "${this.waitApp(project, argv, port)}"`;
  }

  override testE2E(project: Project, argv: TestArgv, options: TestE2EOptions): string {
    return super.testE2E(project, argv, {
      playwrightArgs: options.playwrightArgs,
      prismaDirectory: 'db',
      startCommand:
        options.startCommand ??
        [
          ...prismaScripts.reset(project).split('&&'),
          project.buildCommand,
          `pm2-runtime start ${project.findFile('ecosystem.config.cjs')}`,
        ]
          .map((c) => `${c.trim()}${toDevNull(argv)}`)
          .join(' && '),
    });
  }

  override testE2EDev(project: Project, argv: TestArgv, { playwrightArgs, startCommand }: TestE2EDevOptions): string {
    const port = process.env.PORT || '8080';
    const defaultStartCommand = `blitz dev -p ${port}${toDevNull(argv)}`;
    return super.testE2EDev(project, argv, { playwrightArgs, startCommand: startCommand ?? defaultStartCommand });
  }

  override async testStart(project: Project, argv: ScriptArgv): Promise<string> {
    const port = await findAvailablePort();
    return `WB_ENV=${process.env.WB_ENV} YARN concurrently --kill-others --raw --success first "blitz dev -p ${port}${toDevNull(argv)}" "${this.waitApp(project, argv, port)}"`;
  }
}

export const blitzScripts = new BlitzScripts();
