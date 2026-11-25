import fs from 'node:fs';
import path from 'node:path';

import type { Project } from '../../project.js';
import {
  buildCfCommand,
  buildGenDevVarsCommand,
  buildLocalD1MigrationsApplyCommands,
  getLocalStateDir,
} from '../../utils/cloudflare.js';
import { getCloudflareMode } from '../../utils/cloudflareConfig.js';
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
  const usesVite = usesViteBundler(project);
  if (usesVite) assertViteStateDirConvention(project);
  const serverArgs = usesVite
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
  assertViteStateDirConvention(project);
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

/**
 * wb cannot tell Vite where to keep the local Worker state: the Cloudflare Vite plugin takes it
 * only from `persistState` in the project's vite.config, and defaults to `.cloudflare/state` for
 * every mode. Without the per-mode path there, a test run would serve an unmigrated D1 from the
 * development state while wb migrates and wipes `.cloudflare/state-test`.
 */
function assertViteStateDirConvention(project: Project): void {
  const mode = getCloudflareMode(project);
  if (mode === 'development') return;
  const viteConfigPath = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']
    .map((fileName) => path.join(project.dirPath, fileName))
    .find((filePath) => fs.existsSync(filePath));
  if (viteConfigPath && fs.readFileSync(viteConfigPath, 'utf8').includes('.cloudflare/state-')) return;
  throw new Error(
    `Set the Cloudflare Vite plugin's persistState.path in vite.config to ".cloudflare/state-${mode}" for WB_ENV=${mode} (".cloudflare/state" for development): wb migrates and resets that directory.`
  );
}
