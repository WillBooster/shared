import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import { buildEnvReaderOptionArgs } from '../../sharedOptionsBuilder.js';
import { checkAndKillPortProcess } from '../../utils/port.js';
import { buildShellCommand } from '../../utils/shell.js';
import type { ScriptArgv } from '../builder.js';

import { BaseScripts, buildE2EReadinessCommand, type TestE2EOptions } from './baseScripts.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
export class HttpServerScripts extends BaseScripts {
  constructor() {
    super(false);
  }

  protected override startDevProtected(_: Project, argv: ScriptArgv): string {
    return `YARN build-ts run ${argv.watch ? '--watch' : ''} src/index.ts -- ${argv.normalizedArgsText ?? ''}`;
  }

  override async testE2EProtected(
    project: Project,
    argv: TestArgv,
    startCommand: string,
    options: TestE2EOptions = {},
    isDocker = false
  ): Promise<string> {
    if (project.hasPlaywrightConfig) {
      return super.testE2EProtected(project, argv, startCommand, options, isDocker);
    }

    project.env.PORT ||= '3000';
    const port = await checkAndKillPortProcess(project.env.PORT, project);
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    const targets = argv.targets?.map(String);
    const normalizedTargets = targets?.length ? targets : ['test/e2e/'];
    const testCommand = this.testUnit(project, { ...argv, targets: normalizedTargets });
    return buildShellCommand([
      'YARN',
      'wb',
      'concurrently',
      ...buildEnvReaderOptionArgs(argv),
      '--kill-others',
      '--success',
      'first',
      `${startCommand} && exit 1`,
      `${buildE2EReadinessCommand(port, isDocker)} && ${testCommand}${suffix}`,
    ]);
  }
}

export const httpServerScripts = new HttpServerScripts();
