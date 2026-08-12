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
    // No bundler flag is needed for either project kind: plain Next.js apps run Next.js >= 16.3,
    // which defaults to Turbopack, while Blitz apps pin Next.js 15, which defaults to the webpack
    // dev server that Blitz's withBlitz RPC loader requires (Turbopack ignores webpack loaders).
    return `YARN next dev ${argv.normalizedArgsText ?? ''}`.trim();
  }

  protected override buildDefaultProductionStartCommands(project: Project, argv: ScriptArgv): string[] {
    return [project.buildCommand, `YARN next start ${argv.normalizedArgsText ?? ''}`.trim()];
  }
}

export const nextScripts = new NextScripts();
