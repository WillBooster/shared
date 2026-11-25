import type { Project } from '../../project.js';
import { isProjectEnvironment } from '../../project.js';
import type { ScriptArgv } from '../builder.js';
import { BaseScripts } from './baseScripts.js';
import { buildCloudflareBuiltStartCommands, buildCloudflareDevCommands } from './cloudflareCommands.js';

/**
 * A collection of scripts for executing vinext (Next.js on Vite) apps targeting Cloudflare Workers.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class VinextScripts extends BaseScripts {
  constructor() {
    super(true);
  }

  protected override startDevProtected(project: Project, argv: ScriptArgv): string {
    // The test environment wipes its state directory, so every page would 500 without migrations.
    return buildCloudflareDevCommands(project, argv, {
      appliesD1Migrations: isProjectEnvironment(project, 'test'),
    }).join(' && ');
  }

  protected override buildDefaultProductionStartCommands(project: Project, argv: ScriptArgv): string[] {
    // drizzle/prisma migrations are handled by buildProductionCommand.
    return buildCloudflareBuiltStartCommands(project, argv);
  }
}

export const vinextScripts = new VinextScripts();
