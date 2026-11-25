import type { Project } from '../../project.js';
import {
  buildCfCommand,
  buildGenDevVarsCommand,
  buildLocalD1MigrationsApplyCommands,
  getLocalStateDir,
} from '../../utils/cloudflare.js';
import { getEnsuredPort } from '../../utils/port.js';
import type { ScriptArgv } from '../builder.js';

/** Whether cf delegates the project's dev server and build to Vite (otherwise to Wrangler). */
export function usesViteBundler(project: Project): boolean {
  return project.hasOwnDependency('@cloudflare/vite-plugin');
}

/** Commands serving the Worker from source with `cf dev`. */
export function buildCloudflareDevCommands(
  project: Project,
  argv: ScriptArgv,
  { appliesD1Migrations }: { appliesD1Migrations: boolean }
): string[] {
  const port = getEnsuredPort(project);
  // Vite keeps the local state where the project's vite.config.ts says (`persistState`).
  const serverArgs = usesViteBundler(project)
    ? `--port ${port}`
    : `--ip 127.0.0.1 --port ${port} --persist-to "${getLocalStateDir(project)}"`;
  return [
    // A locally served Worker reads the values of its declared secrets only from .dev.vars.
    buildGenDevVarsCommand(argv, '.dev.vars'),
    // The local D1 starts empty and no dev server applies migrations itself.
    ...(appliesD1Migrations ? buildLocalD1MigrationsApplyCommands(project) : []),
    buildCfCommand(project, 'dev', `-- ${serverArgs} ${argv.normalizedArgsText ?? ''}`.trim()),
  ];
}

/**
 * Commands serving the built Worker. Only Vite has a separate preview server for Build Output;
 * Wrangler's dev server bundles the Worker itself.
 */
export function buildCloudflareBuiltStartCommands(project: Project, argv: ScriptArgv): string[] {
  if (!usesViteBundler(project)) return buildCloudflareDevCommands(project, argv, { appliesD1Migrations: true });
  return [
    // The same build `wb deploy` runs, so the served Worker has the config of wb's mode: the
    // local D1 migrated below is the one whose ID that config declares.
    ...(project.packageJson.scripts?.['gen-code'] ? ['YARN run gen-code'] : []),
    buildCfCommand(project, 'build'),
    buildGenDevVarsCommand(argv, '.dev.vars'),
    ...buildLocalD1MigrationsApplyCommands(project),
    `YARN vite preview --host 127.0.0.1 --port ${getEnsuredPort(project)} --strictPort ${argv.normalizedArgsText ?? ''}`.trim(),
  ];
}
