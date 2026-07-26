import fs from 'node:fs';
import path from 'node:path';

import fg from 'fast-glob';

import type { PackageConfig } from '../packageConfig.js';

import { getWorkspacePackageJsonPaths } from './workspaceUtil.js';

const PRIVATE_SCOPE = '@willbooster-private/';
const VERDACCIO_HOST = 'verdaccio-production-e389.up.railway.app';

/**
 * Whether CI runs of this repository resolve `@willbooster-private/*` packages (or publish to the
 * private Verdaccio registry) and therefore need the VERDACCIO_TOKEN pass-through in their
 * reusable-workflow callers.
 *
 * The scan errs toward FALSE POSITIVES on purpose: a false negative withholds a credential CI
 * needs (installs break or silently skip `.npmrc` generation), while a false positive merely
 * passes a secret the callee ignores. Hence whole-manifest text scans instead of per-field
 * checks. Sources: every workspace package.json (dependencies of any kind, scripts running
 * `bunx @willbooster-private/...`, a Verdaccio `publishConfig.registry`), root lockfiles
 * (covering transitive dependencies), and workflow files (custom jobs resolving private packages
 * outside any manifest; the generated caller pass-through mentions only the secret NAME, never
 * the scope, so it does not turn every caller into a hit). bunfig.toml is deliberately EXCLUDED:
 * `minimumReleaseAgeExcludes` lists the scope in repositories that do not depend on it.
 */
export function repoResolvesPrivatePackages(
  config: Pick<PackageConfig, 'dirPath' | 'doesContainSubPackageJsons' | 'packageJson'>
): boolean {
  const manifestRelPaths = new Set(['package.json', ...getWorkspacePackageJsonPaths(config)]);
  for (const relPath of manifestRelPaths) {
    const content = readFileIfExists(path.resolve(config.dirPath, relPath));
    if (content && (content.includes(PRIVATE_SCOPE) || content.includes(VERDACCIO_HOST))) return true;
  }
  for (const lockfileName of ['bun.lock', 'bun.lockb', 'yarn.lock', 'package-lock.json']) {
    const content = readFileIfExists(path.resolve(config.dirPath, lockfileName));
    if (content?.includes(PRIVATE_SCOPE)) return true;
  }
  const workflowPaths = fg.sync('.github/workflows/*.{yml,yaml}', { cwd: config.dirPath, absolute: true });
  return workflowPaths.some((workflowPath) => readFileIfExists(workflowPath)?.includes(PRIVATE_SCOPE));
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}
