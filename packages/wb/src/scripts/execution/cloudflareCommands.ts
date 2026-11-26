import fs from 'node:fs';
import path from 'node:path';

import semver from 'semver';
import { z } from 'zod';

import type { Project } from '../../project.js';
import {
  buildCfCommand,
  buildGenDevVarsCommand,
  getAbsoluteLocalStateDir,
  getChosenLocalStateDir,
  getLocalStateDir,
} from '../../utils/cloudflare.js';
import { resolveCloudflareMode } from '../../utils/cloudflareConfig.js';
import { getEnsuredPort } from '../../utils/port.js';
import { buildShellEnvironmentAssignment, shellEscapeArgument } from '../../utils/shell.js';
import type { ScriptArgv } from '../builder.js';
import { buildLocalD1MigrationCommands } from '../localD1Scripts.js';

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
    : `--ip 127.0.0.1 --port ${port} --persist-to "${getLocalStateDir(project, mode)}"`;
  return [
    ...buildGenDevVarsCommands(project, argv),
    ...buildLocalD1MigrationCommands(project, mode, !!argv.seedsLocalD1),
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
  if (!usesViteBundler(project)) return buildCloudflareDevCommands(project, { ...argv, seedsLocalD1: true });
  const mode = resolveCloudflareMode(project);
  const stateDirPrefix = buildViteStateDirPrefix(project, mode);
  return [
    // The same build `wb deploy` runs, so the served Worker has the config of wb's mode: the
    // local D1 migrated below is the one whose ID that config declares.
    ...(project.packageJson.scripts?.['gen-code'] ? ['YARN run gen-code'] : []),
    `${stateDirPrefix}${buildViteCommand(project, mode, 'build')}`,
    ...buildGenDevVarsCommands(project, argv),
    ...buildLocalD1MigrationCommands(project, mode, true),
    `${stateDirPrefix}YARN ${getViteExecutable(project)} preview --mode ${shellEscapeArgument(mode)} --host 127.0.0.1 --port ${getEnsuredPort(project)} --strictPort ${argv.normalizedArgsText ?? ''}`.trim(),
  ];
}

/**
 * A locally served Worker reads the values of its declared secrets from `.dev.vars.<mode>` when it
 * exists, else from its process environment. A regular start regenerates that file; an instance
 * on a caller-chosen state directory leaves it to them, so concurrent instances never write it.
 */
function buildGenDevVarsCommands(project: Project, argv: ScriptArgv): string[] {
  return getChosenLocalStateDir(project) ? [] : [buildGenDevVarsCommand(argv)];
}

/**
 * The command `cf dev` / `cf build` delegates to for a Vite project, run directly: cf first
 * detects the project's framework from its dependencies and stops, without a terminal, when it
 * finds more than two (e.g. a vinext app that also depends on hono), although the answer would
 * not change the command. The variable mirrors what cf sets when it delegates.
 */
export function buildViteCommand(project: Project, mode: string, command: 'dev' | 'build', args = ''): string {
  assertVitePluginReadsCloudflareConfig(project);
  return `CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT=true YARN ${getViteExecutable(project)} ${command} --mode ${shellEscapeArgument(mode)} ${args}`.trim();
}

/**
 * A 1.x plugin serves the Worker of a wrangler config instead of `cloudflare.config.ts`, which
 * wb prepares secrets and migrations from, and a 2.0 beta writes another Build Output version;
 * cf refuses both before delegating, so wb does too.
 */
function assertVitePluginReadsCloudflareConfig(project: Project): void {
  for (let dirPath = project.dirPath; ; dirPath = path.dirname(dirPath)) {
    const packageJsonPath = path.join(dirPath, 'node_modules', VITE_PLUGIN_PACKAGE_NAME, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const { version } = z.object({ version: z.string() }).parse(JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')));
      // cf's own range, >=2.0.0-rc.0 <3: earlier 2.0 betas write Build Output v0, which wb cannot read.
      if (!semver.satisfies(version, '>=2.0.0-rc.0 <3', { includePrerelease: true })) {
        throw new Error(
          `${VITE_PLUGIN_PACKAGE_NAME} ${version} cannot build cloudflare.config.ts for wb; install ^2.0.0-rc.0 in ${project.packageJsonPath}.`
        );
      }
      return;
    }
    if (dirPath === path.dirname(dirPath)) return;
  }
}

/** Vite+ (`vp`) when the package declares it, as cf chooses: such a package has no `vite` executable. */
function getViteExecutable(project: Project): string {
  // cf's rule exactly: optional and peer dependencies do not select vp.
  const { dependencies, devDependencies } = project.packageJson;
  return dependencies?.['vite-plus'] || devDependencies?.['vite-plus'] ? 'vp' : 'vite';
}

/**
 * The Cloudflare Vite plugin takes the local state directory only from `persistState` in the
 * project's vite.config, so wb hands the directory it migrates and resets to every Vite command
 * through this variable, which that config reads.
 */
function buildViteStateDirPrefix(project: Project, mode: string): string {
  return `${buildShellEnvironmentAssignment('WB_CLOUDFLARE_STATE_DIR', getAbsoluteLocalStateDir(project, mode))} `;
}
