import { Project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';
import { dockerScripts } from '../dockerScripts.js';

import type { TestE2EDevOptions, TestE2EOptions } from './baseExecutionScripts.js';
import { BaseExecutionScripts } from './baseExecutionScripts.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class HttpServerScripts extends BaseExecutionScripts {
  constructor() {
    super();
  }

  override start(project: Project, argv: ScriptArgv): string {
    return `YARN build-ts run src/index.ts ${argv.watch ? '--watch' : ''} -- ${argv.normalizedArgsText ?? ''}`;
  }

  override startDocker(project: Project, argv: ScriptArgv): string {
    return `${this.buildDocker(project)} && ${dockerScripts.stopAndStart(
      project,
      false,
      argv.normalizedDockerArgsText ?? '',
      argv.normalizedArgsText ?? ''
    )}`;
  }

  override startProduction(project: Project, argv: ScriptArgv, port = 8080): string {
    return `NODE_ENV=production ${project.getBuildCommand(
      argv
    )} && NODE_ENV=production PORT=\${PORT:-${port}} node dist/index.js ${argv.normalizedArgsText ?? ''}`;
  }

  override testE2E(
    project: Project,
    argv: ScriptArgv,
    {
      startCommand = `if [ -e "prisma" ]; then prisma migrate reset --force --skip-generate; fi && (${this.startProduction(
        project,
        argv
      )})`,
    }: TestE2EOptions
  ): string {
    return `NODE_ENV=production WB_ENV=${process.env.WB_ENV} PORT=8080 YARN concurrently --kill-others --raw --success first
      "${startCommand} && exit 1"
      "wait-on -t 600000 -i 2000 http://127.0.0.1:8080 && vitest run tests/e2e --color --passWithNoTests"`;
  }

  override testE2EDev(project: Project, argv: ScriptArgv, { startCommand }: TestE2EDevOptions): string {
    return `NODE_ENV=production WB_ENV=${
      process.env.WB_ENV
    } PORT=8080 YARN concurrently --kill-others --raw --success first
      "${startCommand || this.start(project, argv)} && exit 1"
      "wait-on -t 600000 -i 2000 http://127.0.0.1:8080 && vitest run tests/e2e --color --passWithNoTests"`;
  }

  override testStart(project: Project, argv: ScriptArgv): string {
    return `YARN concurrently --kill-others --raw --success first "${this.start(project, argv)}" "${this.waitApp(
      project,
      argv
    )}"`;
  }
}

export const httpServerScripts = new HttpServerScripts();
