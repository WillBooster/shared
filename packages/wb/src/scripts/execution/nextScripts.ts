import type { Project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';

import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing Next.js commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class NextScripts extends BaseScripts {
  constructor() {
    super(true);
  }

  protected override startDevProtected(_: Project, argv: ScriptArgv): string {
    return `YARN next dev --turbopack ${argv.normalizedArgsText ?? ''}`;
  }

  protected override buildDefaultProductionStartCommands(project: Project, argv: ScriptArgv): string[] {
    return [project.buildCommand, `YARN next start ${argv.normalizedArgsText ?? ''}`.trim()];
  }
}

export const nextScripts = new NextScripts();
