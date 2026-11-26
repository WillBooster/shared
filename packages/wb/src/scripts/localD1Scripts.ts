import type { Project } from '../project.js';
import {
  buildLocalD1MigrationsApplyCommands,
  getChosenLocalStateDir,
  getLocalStateDir,
  wrapWithLocalD1DatabaseUrl,
} from '../utils/cloudflare.js';
import type { D1Migrations } from '../utils/cloudflareConfig.js';
import { resolveLocalCloudflareConfig, selectD1Migrations } from '../utils/cloudflareConfig.js';
import { drizzleScripts, usesDrizzleKitForD1 } from './drizzleScripts.js';

/**
 * Commands migrating the mode's local D1 databases with the mechanism `selectD1Migrations`
 * selects, which every local launch of the Worker runs: the local D1 starts empty and no dev
 * server applies migrations itself. With `seeds`, the drizzle-kit migration also runs the
 * package's seed, which may rewrite data and so runs only where the launch prepares its data.
 */
export function buildLocalD1MigrationCommands(project: Project, mode: string, seeds: boolean): string[] {
  const { cfNativeD1Migrations, drizzleD1Database } = selectLocalD1Migrations(project, mode);
  return [
    ...buildLocalD1MigrationsApplyCommands(project, mode, cfNativeD1Migrations),
    ...(drizzleD1Database
      ? [
          wrapWithLocalD1DatabaseUrl(
            project,
            mode,
            // A chosen state directory belongs to its caller, who seeds it with `wb db migrate`.
            seeds && !getChosenLocalStateDir(project) ? drizzleScripts.migrate(project) : drizzleScripts.deploy(project)
          ),
        ]
      : []),
  ];
}

/**
 * Commands for `wb db deploy|migrate|reset` of the package's cf-native D1 bindings, which drizzle-kit
 * must not migrate a second time under its own journal: `reset` first deletes the local D1 state,
 * and `migrate`/`reset` then run the seed of a Drizzle package whose config targets that D1.
 * Undefined when no D1 binding of the package is migrated cf-natively.
 */
export function buildCfNativeD1DatabaseCommands(
  project: Project,
  mode: string,
  kind: 'deploy' | 'migrate' | 'reset'
): string[] | undefined {
  const { cfNativeD1Migrations } = selectLocalD1Migrations(project, mode);
  if (cfNativeD1Migrations.length === 0) return;

  const seedCommand = kind !== 'deploy' && usesDrizzleKitForD1(project) ? drizzleScripts.seed(project) : 'true';
  // The seed gets its database through wrapWithLocalD1DatabaseUrl, which cannot tell D1 files apart.
  if (seedCommand !== 'true' && cfNativeD1Migrations.length > 1) {
    throw new Error(`wb db ${kind} seeds only a package with a single D1 binding; ${project.name} has several.`);
  }
  return [
    ...(kind === 'reset' ? [`rm -Rf "${getLocalStateDir(project, mode)}/v3/d1"`] : []),
    ...buildLocalD1MigrationsApplyCommands(project, mode, cfNativeD1Migrations),
    ...(seedCommand === 'true' ? [] : [wrapWithLocalD1DatabaseUrl(project, mode, seedCommand)]),
  ];
}

/** The migration mechanisms of the mode's D1 bindings; throws for a combination wb does not support. */
export function selectLocalD1Migrations(project: Project, mode: string): D1Migrations {
  const d1Migrations = selectD1Migrations(
    project,
    resolveLocalCloudflareConfig(project, mode)?.d1Databases ?? [],
    usesDrizzleKitForD1(project)
  );
  if (d1Migrations.errorMessage) throw new Error(d1Migrations.errorMessage);
  return d1Migrations;
}
