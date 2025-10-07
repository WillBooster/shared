import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';
import { toDevNull } from '../builder.js';
import { prismaScripts } from '../prismaScripts.js';

import type { TestE2EDevOptions, TestE2EOptions } from './baseScripts.js';
import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing Remix commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class RemixScripts extends BaseScripts {
  override start(project: Project, argv: ScriptArgv): string {
    return `YARN concurrently --raw --kill-others-on-fail
      "remix dev ${argv.normalizedArgsText ?? ''}"
      "${this.waitAndOpenApp(project, argv)}"`;
  }

  override startProduction(project: Project, argv: ScriptArgv, port: number): string {
    return `NODE_ENV=production YARN concurrently --raw --kill-others-on-fail
      "${prismaScripts.migrate(project)} && ${project.buildCommand} && PORT=${port} pm2-runtime start ${project.findFile(
        'ecosystem.config.cjs'
      )} ${argv.normalizedArgsText ?? ''}"
      "${this.waitAndOpenApp(project, argv, port)}"`;
  }

  override testE2E(project: Project, argv: TestArgv, options: TestE2EOptions): string {
    return super.testE2E(project, argv, {
      playwrightArgs: options.playwrightArgs,
      prismaDirectory: 'prisma',
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

  override testE2EDev(
    project: Project,
    argv: TestArgv,
    { playwrightArgs, startCommand = `remix dev${toDevNull(argv)}` }: TestE2EDevOptions
  ): string {
    return super.testE2EDev(project, argv, { playwrightArgs, startCommand });
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

  override testStart(project: Project, argv: ScriptArgv): string {
    return `WB_ENV=${process.env.WB_ENV} YARN concurrently --kill-others --raw --success first "remix dev${toDevNull(argv)}" "${this.waitApp(project, argv)}"`;
  }
}

export const remixScripts = new RemixScripts();
