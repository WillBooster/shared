import fs from 'node:fs';
import path from 'node:path';

import type { PackageJson } from 'type-fest';

import type { PackageConfig } from '../packageConfig.js';

import { getWorkspacePackageJsonPaths } from './workspaceUtil.js';

const PRIVATE_SCOPE = '@willbooster-private/';

const privateRegistryHost = 'verdaccio-production-e389.up.railway.app';
export const privateRegistryScopeMapping = `@willbooster-private:registry=https://${privateRegistryHost}/`;

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
  return getPackageManifests(config).some((manifest) => {
    if (manifest.name?.startsWith(PRIVATE_SCOPE)) return true;
    return [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ].some((dependencies) => Object.keys(dependencies ?? {}).some((name) => name.startsWith(PRIVATE_SCOPE)));
  });
}

/** Whether the manifest at a semantic-release npm target is publishable through the public registry. */
export function packagePublishesPublicPackage(dirPath: string): boolean | undefined {
  const manifest = readPackageJsonIfExists(path.resolve(dirPath, 'package.json'));
  if (manifest?.private === true) return false;
  if (!manifest?.name) return undefined;
  return packageMetadataTargetsPublicRegistry(manifest);
}

/** Whether source metadata rules out publishing through npm's public registry. */
export function packageMetadataTargetsPublicRegistry(manifest: PackageJson | undefined): boolean {
  if (manifest?.name?.startsWith(PRIVATE_SCOPE)) return false;
  const registry = manifest?.publishConfig?.registry;
  if (!registry) return true;
  try {
    return new URL(registry).hostname === 'registry.npmjs.org';
  } catch {
    return false;
  }
}

function getPackageManifests(
  config: Pick<PackageConfig, 'dirPath' | 'doesContainSubPackageJsons' | 'packageJson'>
): PackageJson[] {
  const manifestRelPaths = new Set(['package.json', ...getWorkspacePackageJsonPaths(config)]);
  return [...manifestRelPaths].flatMap((relPath) => {
    const manifest = readPackageJsonIfExists(path.resolve(config.dirPath, relPath));
    return manifest ? [manifest] : [];
  });
}

function readPackageJsonIfExists(filePath: string): PackageJson | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PackageJson;
  } catch {
    return undefined;
  }
}
