import type { Project } from '../../project.js';
import { LOCAL_WRANGLER_STATE_DIR } from '../../utils/wrangler.js';
import type { ScriptArgv } from '../builder.js';

import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing vinext (Next.js on Vite) apps targeting Cloudflare Workers.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class VinextScripts extends BaseScripts {
  constructor() {
    super(true);
  }

  protected override startDevProtected(project: Project, argv: ScriptArgv): string {
    project.env.PORT ||= '3000';
    // Unlike `next dev`, Vite-based vinext does not read the PORT environment variable.
    return `YARN vinext dev --port ${project.env.PORT} ${argv.normalizedArgsText ?? ''}`.trim();
  }

  protected override buildDefaultProductionStartCommands(project: Project, argv: ScriptArgv): string[] {
    project.env.PORT ||= '3000';
    const port = project.env.PORT;
    // `vinext build` emits a worker bundle and its wrangler config under dist/server.
    // `--local-upstream` keeps request URLs on the local host; otherwise, wrangler dev simulates
    // the production custom domain declared in the wrangler config routes.
    return [
      project.buildCommand,
      `YARN wrangler dev --config dist/server/wrangler.json --ip 127.0.0.1 --port ${port} --persist-to "${LOCAL_WRANGLER_STATE_DIR}" --local-upstream localhost:${port} ${argv.normalizedArgsText ?? ''}`.trim(),
    ];
  }
}

export const vinextScripts = new VinextScripts();
