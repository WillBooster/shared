import type { Project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';

import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing Remix commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class RemixScripts extends BaseScripts {
  constructor() {
    super(true);
  }

  protected override startDevProtected(_: Project, argv: ScriptArgv): string {
    return `remix dev ${argv.normalizedArgsText ?? ''}`;
  }
}

export const remixScripts = new RemixScripts();
