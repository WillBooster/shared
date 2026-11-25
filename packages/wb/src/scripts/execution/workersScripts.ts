import type { Project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';
import { buildCloudflareBuiltStartCommands, buildCloudflareDevCommands } from './cloudflareCommands.js';
import { HttpServerScripts } from './httpServerScripts.js';

/**
 * A collection of scripts for executing plain Cloudflare Workers apps (detected via
 * `cloudflare.config.ts` when the app is not a vinext one, which has its own scripts).
 * Extends HttpServerScripts so that e2e tests run via the unit-test runner against the running
 * worker when the project has no Playwright config.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class WorkersScripts extends HttpServerScripts {
  protected override startDevProtected(project: Project, argv: ScriptArgv): string {
    return buildCloudflareDevCommands(project, argv).join(' && ');
  }

  protected override buildDefaultProductionStartCommands(project: Project, argv: ScriptArgv): string[] {
    return buildCloudflareBuiltStartCommands(project, argv);
  }
}

export const workersScripts = new WorkersScripts();
