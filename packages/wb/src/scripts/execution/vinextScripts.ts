import type { Project } from '../../project.js';
import { isProjectEnvironment } from '../../project.js';
import {
  buildD1MigrationsApplyCommand,
  buildGenDevVarsCommand,
  buildWranglerDevCommand,
  getLocalWranglerStateDir,
} from '../../utils/wrangler.js';
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
    const devCommand = `YARN vinext dev --port ${project.env.PORT} ${argv.normalizedArgsText ?? ''}`.trim();
    // The Cloudflare vite plugin (miniflare) reads runtime vars only from a .dev.vars file,
    // so it must be regenerated from the wb-managed .env files before serving.
    const commands = [buildGenDevVarsCommand(argv, '.dev.vars')];
    // `vinext dev` (miniflare) starts with an empty local D1 and applies no migrations itself;
    // the test environment wipes its state directory, so every page would 500 without this.
    const migrationCommand = isProjectEnvironment(project, 'test') ? buildD1MigrationsApplyCommand(project) : undefined;
    if (migrationCommand) commands.push(migrationCommand);
    return [...commands, devCommand].join(' && ');
  }

  protected override buildDefaultProductionStartCommands(project: Project, argv: ScriptArgv): string[] {
    project.env.PORT ||= '3000';
    const port = project.env.PORT;
    // Serving the built worker starts from an empty (or wiped) local D1, so wrangler-native
    // migrations (if any) must be applied first; drizzle/prisma migrations are handled by
    // buildProductionCommand.
    const d1MigrationsCommand = buildD1MigrationsApplyCommand(project);
    // `vinext build` emits a worker bundle and its wrangler config under dist/server, so the
    // .dev.vars file exposing wb-managed environment variables must be generated after building.
    // `--local-upstream` keeps request URLs on the local host; otherwise, wrangler dev simulates
    // the production custom domain declared in the wrangler config routes.
    return [
      project.buildCommand,
      buildGenDevVarsCommand(argv, 'dist/server/.dev.vars'),
      ...(d1MigrationsCommand ? [d1MigrationsCommand] : []),
      buildWranglerDevCommand(
        `dev --config dist/server/wrangler.json --ip 127.0.0.1 --port ${port} --persist-to "${getLocalWranglerStateDir(project)}" --local-upstream localhost:${port} ${argv.normalizedArgsText ?? ''}`.trim()
      ),
    ];
  }
}

export const vinextScripts = new VinextScripts();
