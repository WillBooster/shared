import type { Project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';

import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing Vite-based apps with Playwright e2e tests.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class ViteScripts extends BaseScripts {
  constructor() {
    super(true);
  }

  protected override startDevProtected(_: Project, argv: ScriptArgv): string {
    return `YARN vite dev ${argv.normalizedArgsText ?? ''}`;
  }

  protected override startProductionProtected(project: Project, argv: ScriptArgv): string {
    return `${project.buildCommand} && YARN vite preview ${argv.normalizedArgsText ?? ''}`.trim();
  }
}

export const viteScripts = new ViteScripts();
