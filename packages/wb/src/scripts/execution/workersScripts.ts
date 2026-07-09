import type { Project } from '../../project.js';
import {
  buildGenDevVarsCommand,
  buildWranglerDevCommand,
  findD1MigrationsDirPath,
  getD1DatabaseName,
  getLocalWranglerStateDir,
} from '../../utils/wrangler.js';
import type { ScriptArgv } from '../builder.js';

import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing plain Cloudflare Workers apps (detected via a wrangler
 * config file when no other framework matches; vinext apps have their own scripts).
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class WorkersScripts extends BaseScripts {
  constructor() {
    super(false);
  }

  protected override startDevProtected(project: Project, argv: ScriptArgv): string {
    return this.buildWranglerDevCommands(project, argv).join(' && ');
  }

  protected override buildDefaultProductionStartCommands(project: Project, argv: ScriptArgv): string[] {
    // wrangler dev bundles the worker itself, so no separate build step is needed.
    return this.buildWranglerDevCommands(project, argv);
  }

  private buildWranglerDevCommands(project: Project, argv: ScriptArgv): string[] {
    project.env.PORT ||= '8787';
    const stateDir = getLocalWranglerStateDir(project);

    // These helpers read the default-named wrangler config; that is safe because workersScripts
    // itself is only selected when such a config file exists in the project directory.
    const commands = [buildGenDevVarsCommand(argv, '.dev.vars')];
    // Apply wrangler-native D1 migrations (if any) so the local database matches the deployed one.
    // CI=true suppresses wrangler's interactive confirmation prompt.
    const d1DatabaseName = getD1DatabaseName(project);
    if (d1DatabaseName && findD1MigrationsDirPath(project)) {
      commands.push(`CI=true YARN wrangler d1 migrations apply ${d1DatabaseName} --local --persist-to "${stateDir}"`);
    }
    commands.push(
      buildWranglerDevCommand(
        project,
        `dev --ip 127.0.0.1 --port ${project.env.PORT} --persist-to "${stateDir}" ${argv.normalizedArgsText ?? ''}`.trim()
      )
    );
    return commands;
  }
}

export const workersScripts = new WorkersScripts();
