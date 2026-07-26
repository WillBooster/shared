import { httpServerPackages } from '../../commands/httpServerPackages.js';
import type { Project } from '../../project.js';
import { findWranglerConfigPath } from '../../utils/wrangler.js';
import type { BaseScripts } from './baseScripts.js';
import { httpServerScripts } from './httpServerScripts.js';
import { nextScripts } from './nextScripts.js';
import { plainAppScripts } from './plainAppScripts.js';
import { vinextScripts } from './vinextScripts.js';
import { viteScripts } from './viteScripts.js';
import { workersScripts } from './workersScripts.js';

/** Picks the scripts implementation for the project (the selection `wb test`/`wb test-on-ci` share). */
export function selectScripts(project: Project): BaseScripts {
  return selectFrameworkScripts(project) ?? (dependsOnHttpServerPackage(project) ? httpServerScripts : plainAppScripts);
}

/** The framework-detection prefix every consumer shares; `wb start` composes its own tail around it. */
export function selectFrameworkScripts(project: Project): BaseScripts | undefined {
  const deps = project.packageJson.dependencies ?? {};
  const devDeps = project.packageJson.devDependencies ?? {};
  // vinext apps also depend on next, so this check must come first.
  if (deps.vinext || devDeps.vinext) return vinextScripts;
  if (deps.next) return nextScripts;
  if (devDeps.vite) return viteScripts;
  // Plain Cloudflare Workers app; vinext apps are detected above.
  if (findWranglerConfigPath(project)) return workersScripts;
  return;
}

export function dependsOnHttpServerPackage(project: Project): boolean {
  const deps = project.packageJson.dependencies ?? {};
  return httpServerPackages.some((p) => deps[p]) && !deps['firebase-functions'];
}
