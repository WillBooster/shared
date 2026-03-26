import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import { checkAndKillPortProcess } from '../../utils/port.js';
import { buildShellCommand } from '../../utils/shell.js';
import type { ScriptArgv } from '../builder.js';

import { BaseScripts, type TestE2EOptions } from './baseScripts.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class HttpServerScripts extends BaseScripts {
  constructor() {
    super(false);
  }

  protected override startDevProtected(_: Project, argv: ScriptArgv): string {
    return `YARN build-ts run ${argv.watch ? '--watch' : ''} src/index.ts -- ${argv.normalizedArgsText ?? ''}`;
  }

  async testE2EProtected(
    project: Project,
    argv: TestArgv,
    startCommand: string,
    options: TestE2EOptions = {}
  ): Promise<string> {
    if (project.hasPlaywrightConfig) {
      return super.testE2EProtected(project, argv, startCommand, options);
    }

    const port = await checkAndKillPortProcess(project.env.PORT, project);
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    const targets = argv.targets?.map(String);
    return buildShellCommand([
      'YARN',
      'wb',
      'concurrently',
      '--kill-others',
      '--success',
      'first',
      `${startCommand} && exit 1`,
      `wait-on -t 600000 -i 2000 http-get://127.0.0.1:${port}
        && ${buildShellCommand([
          'vitest',
          'run',
          ...(targets && targets.length > 0 ? targets : ['test/e2e/']),
          '--color',
          '--passWithNoTests',
          '--allowOnly',
          ...(argv.bail ? ['--bail=1'] : []),
        ])}${suffix}`,
    ]);
  }
}

export const httpServerScripts = new HttpServerScripts();
