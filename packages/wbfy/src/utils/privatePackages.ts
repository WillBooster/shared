import fs from 'node:fs';
import path from 'node:path';

import type { PackageJson } from 'type-fest';

import { getWorkspacePackageJsonPaths, type WorkspaceRootLike } from './workspaceUtil.js';

const PRIVATE_SCOPE = '@willbooster-private/';

const privateRegistryHost = 'verdaccio-production-e389.up.railway.app';
export const privateRegistryScopeMapping = `@willbooster-private:registry=https://${privateRegistryHost}/`;

/**
 * Whether this repository deals with `@willbooster-private/*` packages — by convention that scope
 * lives exclusively on the private Verdaccio registry, so exactly these repositories need the
 * VERDACCIO_TOKEN pass-through in their reusable-workflow callers.
 *
 * A repository qualifies when any workspace package.json DECLARES a dependency in the scope (any
 * dependency field), or is itself NAMED in the scope (it publishes to Verdaccio). Nothing else is
 * scanned: lockfiles only mirror the declared dependencies, and bunfig.toml's
 * `minimumReleaseAgeExcludes` mentions the scope even in repositories that do not depend on it.
 */
export function repoResolvesPrivatePackages(config: WorkspaceRootLike): boolean {
  return readWorkspaceManifests(config).some((manifest) => {
    if (manifest.name?.startsWith(PRIVATE_SCOPE)) return true;
    return [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ].some((dependencies) => Object.keys(dependencies ?? {}).some((name) => name.startsWith(PRIVATE_SCOPE)));
  });
}

/**
 * Whether any workspace package publishes to Verdaccio (named in the private scope and not marked
 * `private`), so its release caller needs the VERDACCIO_PUBLISH_TOKEN pass-through.
 */
export function repoPublishesPrivatePackages(config: WorkspaceRootLike): boolean {
  return readWorkspaceManifests(config).some(
    (manifest) => manifest.name?.startsWith(PRIVATE_SCOPE) === true && manifest.private !== true
  );
}

function readWorkspaceManifests(config: WorkspaceRootLike): PackageJson[] {
  const manifestRelPaths = new Set(['package.json', ...getWorkspacePackageJsonPaths(config)]);
  return [...manifestRelPaths]
    .map((relPath) => readPackageJsonIfExists(path.resolve(config.dirPath, relPath)))
    .filter((manifest) => manifest !== undefined);
}

function readPackageJsonIfExists(filePath: string): PackageJson | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PackageJson;
  } catch {
    return undefined;
  }
}
