import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import { findAvailablePort } from '../../utils/findPort.js';
import { runtimeWithArgs } from '../../utils/runtime.js';
import type { ScriptArgv } from '../builder.js';
import { toDevNull } from '../builder.js';
import { dockerScripts } from '../dockerScripts.js';

import type { TestE2EDevOptions, TestE2EOptions } from './baseScripts.js';
import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class HttpServerScripts extends BaseScripts {
  override start(project: Project, argv: ScriptArgv): string {
    const port = Number(process.env.PORT) || 3000;
    return `PORT=${port} YARN build-ts run ${argv.watch ? '--watch' : ''} src/index.ts -- ${argv.normalizedArgsText ?? ''}`;
  }

  override startDocker(project: Project, argv: ScriptArgv): string {
    return `${this.buildDocker(project)}${toDevNull(argv)} && ${dockerScripts.stopAndStart(
      project,
      false,
      argv.normalizedDockerOptionsText ?? '',
      argv.normalizedArgsText ?? ''
    )}`;
  }

  override startProduction(project: Project, argv: ScriptArgv, port = 8080): string {
    return `NODE_ENV=production ${
      project.buildCommand
    }${toDevNull(argv)} && NODE_ENV=production PORT=\${PORT:-${port}} ${runtimeWithArgs} dist/index.js ${argv.normalizedArgsText ?? ''}`;
  }

  override startTest(project: Project, argv: ScriptArgv): string {
    return `${project.hasPrisma ? 'prisma migrate reset --force --skip-generate && ' : ''}(${this.startProduction(
      project,
      argv
    )})`;
  }

  override testE2E(
    project: Project,
    argv: TestArgv,
    {
      startCommand = `${project.hasPrisma ? 'prisma migrate reset --force --skip-generate && ' : ''}(${this.startProduction(
        project,
        argv
      )})`,
    }: TestE2EOptions
  ): string {
    const port = process.env.PORT || '8080';
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    const testTarget = argv.targets && argv.targets.length > 0 ? argv.targets.join(' ') : 'test/e2e/';
    return `NODE_ENV=production WB_ENV=${project.env.WB_ENV} PORT=${port} YARN concurrently --kill-others --raw --success first
      "${startCommand} && exit 1"
      "wait-on -t 600000 -i 2000 http-get://127.0.0.1:${port} && vitest run ${testTarget} --color --passWithNoTests --allowOnly${suffix}"`;
  }

  override testE2EDev(project: Project, argv: TestArgv, { startCommand }: TestE2EDevOptions): string {
    const port = process.env.PORT || '8080';
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    const testTarget = argv.targets && argv.targets.length > 0 ? argv.targets.join(' ') : 'test/e2e/';
    return `NODE_ENV=production WB_ENV=${
      project.env.WB_ENV
    } PORT=${port} YARN concurrently --kill-others --raw --success first
      "${startCommand ?? this.start(project, argv)} && exit 1"
      "wait-on -t 600000 -i 2000 http-get://127.0.0.1:${port} && vitest run ${testTarget} --color --passWithNoTests --allowOnly${suffix}"`;
  }

  override async testStart(project: Project, argv: ScriptArgv): Promise<string> {
    const port = await findAvailablePort();
    return `WB_ENV=${process.env.WB_ENV} PORT=${port} YARN concurrently --kill-others --raw --success first "${this.start(project, argv)}" "${this.waitApp(project, argv, port)}"`;
  }
}

export const httpServerScripts = new HttpServerScripts();
