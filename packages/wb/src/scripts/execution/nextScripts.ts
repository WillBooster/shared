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
    return `next dev --turbopack ${argv.normalizedArgsText ?? ''}`;
  }
}

export const nextScripts = new NextScripts();
