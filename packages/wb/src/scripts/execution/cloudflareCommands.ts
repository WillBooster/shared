import fs from 'node:fs';
import path from 'node:path';

import type { Project } from '../../project.js';
import {
  buildCfCommand,
  buildGenDevVarsCommand,
  buildLocalD1MigrationsApplyCommands,
  getAbsoluteLocalStateDir,
  getLocalStateDir,
} from '../../utils/cloudflare.js';
import { resolveCloudflareMode } from '../../utils/cloudflareConfig.js';
import { getEnsuredPort } from '../../utils/port.js';
import { buildShellEnvironmentAssignment, shellEscapeArgument } from '../../utils/shell.js';
import type { ScriptArgv } from '../builder.js';
import { usesDrizzleKitForD1 } from '../drizzleScripts.js';

const VITE_PLUGIN_PACKAGE_NAME = '@cloudflare/vite-plugin';

/**
 * Whether Vite serves and builds the project (otherwise Wrangler does, through cf). The package's
 * own dependency decides, as it does for cf, so a vite.config using the plugin without declaring
 * it would be served by one tool and prepared for the other.
 */
export function usesViteBundler(project: Project): boolean {
  if (project.hasOwnDependency(VITE_PLUGIN_PACKAGE_NAME)) return true;
  const usesUndeclaredPlugin = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']
    .map((fileName) => path.join(project.dirPath, fileName))
    .some(
      (filePath) => fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes(VITE_PLUGIN_PACKAGE_NAME)
    );
  if (usesUndeclaredPlugin) {
    throw new Error(
      `${project.packageJsonPath} must declare ${VITE_PLUGIN_PACKAGE_NAME} (and vite) among its own dependencies: its vite.config uses the plugin, and cf selects the bundler by that declaration.`
    );
  }
  return false;
}

/** Commands serving the Worker from source. */
export function buildCloudflareDevCommands(project: Project, argv: ScriptArgv): string[] {
  const mode = resolveCloudflareMode(project);
  const port = getEnsuredPort(project);
  const usesVite = usesViteBundler(project);
  const serverArgs = usesVite
    ? `--port ${port}`
    : `--ip 127.0.0.1 --port ${port} --persist-to "${getLocalStateDir(mode)}"`;
  return [
    // A locally served Worker reads the values of its declared secrets only from this file.
    buildGenDevVarsCommand(argv),
    // The local D1 starts empty and no dev server applies migrations itself.
    ...buildLocalD1MigrationsApplyCommands(project, mode, usesDrizzleKitForD1(project)),
    usesVite
      ? `${buildViteStateDirPrefix(project, mode)}${buildViteCommand(project, mode, 'dev', `${serverArgs} ${argv.normalizedArgsText ?? ''}`.trim())}`
      : buildCfCommand(mode, 'dev', `-- ${serverArgs} ${argv.normalizedArgsText ?? ''}`.trim()),
  ];
}

/**
 * Commands serving the built Worker. Only Vite has a separate preview server for Build Output;
 * Wrangler's dev server bundles the Worker itself.
 */
export function buildCloudflareBuiltStartCommands(project: Project, argv: ScriptArgv): string[] {
  if (!usesViteBundler(project)) return buildCloudflareDevCommands(project, argv);
  const mode = resolveCloudflareMode(project);
  const stateDirPrefix = buildViteStateDirPrefix(project, mode);
  return [
    // The same build `wb deploy` runs, so the served Worker has the config of wb's mode: the
    // local D1 migrated below is the one whose ID that config declares.
    ...(project.packageJson.scripts?.['gen-code'] ? ['YARN run gen-code'] : []),
    `${stateDirPrefix}${buildViteCommand(project, mode, 'build')}`,
    buildGenDevVarsCommand(argv),
    ...buildLocalD1MigrationsApplyCommands(project, mode, usesDrizzleKitForD1(project)),
    `${stateDirPrefix}YARN ${getViteExecutable(project)} preview --mode ${shellEscapeArgument(mode)} --host 127.0.0.1 --port ${getEnsuredPort(project)} --strictPort ${argv.normalizedArgsText ?? ''}`.trim(),
  ];
}

/**
 * The command `cf dev` / `cf build` delegates to for a Vite project, run directly: cf first
 * detects the project's framework from its dependencies and stops, without a terminal, when it
 * finds more than two (e.g. a vinext app that also depends on hono), although the answer would
 * not change the command. The variable is the one cf sets to make the plugin write Build Output.
 */
export function buildViteCommand(project: Project, mode: string, command: 'dev' | 'build', args = ''): string {
  return `CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT=true YARN ${getViteExecutable(project)} ${command} --mode ${shellEscapeArgument(mode)} ${args}`.trim();
}

/** Vite+ (`vp`) when the package declares it, as cf chooses: such a package has no `vite` executable. */
function getViteExecutable(project: Project): string {
  return project.hasOwnDependency('vite-plus') ? 'vp' : 'vite';
}

/**
 * The Cloudflare Vite plugin takes the local state directory only from `persistState` in the
 * project's vite.config, so wb hands the directory it migrates and resets to every Vite command
 * through this variable, which that config reads.
 */
function buildViteStateDirPrefix(project: Project, mode: string): string {
  return `${buildShellEnvironmentAssignment('WB_CLOUDFLARE_STATE_DIR', getAbsoluteLocalStateDir(project, mode))} `;
}
