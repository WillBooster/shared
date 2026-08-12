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

  protected override startDevProtected(project: Project, argv: ScriptArgv): string {
    // Blitz's withBlitz wires its RPC layer through a webpack loader, which Turbopack ignores,
    // so Blitz apps must run the webpack dev server (Turbopack dies with resolve errors).
    const bundlerOption = project.packageJson.dependencies?.blitz ? '--webpack ' : '';
    return `YARN next dev ${bundlerOption}${argv.normalizedArgsText ?? ''}`;
  }

  protected override buildDefaultProductionStartCommands(project: Project, argv: ScriptArgv): string[] {
    return [project.buildCommand, `YARN next start ${argv.normalizedArgsText ?? ''}`.trim()];
  }
}

export const nextScripts = new NextScripts();
