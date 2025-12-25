import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import { checkAndKillPortProcess } from '../../utils/port.js';
import type { ScriptArgv } from '../builder.js';

import { BaseScripts } from './baseScripts.js';

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

  async testE2EProtected(project: Project, argv: TestArgv, startCommand: string): Promise<string> {
    const port = await checkAndKillPortProcess(project.env.PORT, project);
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    const testTarget = argv.targets && argv.targets.length > 0 ? argv.targets.join(' ') : 'test/e2e/';
    const quickOption = argv.quick ? ' --bail=1' : '';

    return `YARN concurrently --kill-others --raw --success first
      "${startCommand} && exit 1"
      "wait-on -t 600000 -i 2000 http-get://127.0.0.1:${port}
        && vitest run ${testTarget} --color --passWithNoTests --allowOnly${quickOption}${suffix}"`;
  }
}

export const httpServerScripts = new HttpServerScripts();
