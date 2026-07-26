import fs from 'node:fs';
import path from 'node:path';

import type { PackageJson } from 'type-fest';

import type { PackageConfig } from '../packageConfig.js';

import { getWorkspacePackageJsonPaths } from './workspaceUtil.js';

const PRIVATE_SCOPE = '@willbooster-private/';

/**
 * Whether this repository deals with `@willbooster-private/*` packages — by convention that scope
 * lives exclusively on the private Verdaccio registry, so exactly these repositories need the
 * VERDACCIO_TOKEN pass-through in their reusable-workflow callers.
 *
 * A repository qualifies when any workspace package.json DECLARES a dependency in the scope (any
 * dependency field), or is itself NAMED in the scope (it publishes to Verdaccio, and release.yml
 * derives its npm auth from the same secret). Nothing else is scanned: lockfiles only mirror the
 * declared dependencies, and bunfig.toml's `minimumReleaseAgeExcludes` mentions the scope even in
 * repositories that do not depend on it.
 */
export function repoResolvesPrivatePackages(
  config: Pick<PackageConfig, 'dirPath' | 'doesContainSubPackageJsons' | 'packageJson'>
): boolean {
  const manifestRelPaths = new Set(['package.json', ...getWorkspacePackageJsonPaths(config)]);
  return [...manifestRelPaths].some((relPath) => {
    const manifest = readPackageJsonIfExists(path.resolve(config.dirPath, relPath));
    if (!manifest) return false;
    if (manifest.name?.startsWith(PRIVATE_SCOPE)) return true;
    return [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ].some((dependencies) => Object.keys(dependencies ?? {}).some((name) => name.startsWith(PRIVATE_SCOPE)));
  });
}

function readPackageJsonIfExists(filePath: string): PackageJson | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PackageJson;
  } catch {
    return undefined;
  }
}
