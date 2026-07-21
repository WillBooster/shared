import path from 'node:path';

import type { PackageConfig } from '../packageConfig.js';

/**
 * Returns the module specifier a generated config file should use to load a
 * willbooster-configs config package such as `@willbooster/oxlint-config`.
 *
 * Outside willbooster-configs this is simply the published package name. Inside
 * willbooster-configs the package must not be declared as a dependency: the
 * config packages import one another (e.g. oxfmt-config's oxlint.config.ts
 * imports oxlint-config and vice versa), so a declared edge would form a
 * dependency cycle that multi-semantic-release cannot topologically sort. Since
 * the edge is absent, isolated installs cannot resolve the bare package name, so
 * import the committed `config.mjs` build output through a relative path instead.
 */
export function resolveWillboosterConfigModule(
  config: PackageConfig,
  rootConfig: PackageConfig,
  configPackageName: string
): string {
  if (!config.isWillBoosterConfigs) return configPackageName;

  // e.g. '@willbooster/oxlint-config' -> 'oxlint-config', which is its directory under `packages/`.
  const configPackageDir = configPackageName.slice(configPackageName.indexOf('/') + 1);
  const localEntry = path.resolve(rootConfig.dirPath, 'packages', configPackageDir, 'config.mjs');
  const relativePath = path.relative(config.dirPath, localEntry);
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

export function isPublishedWillboosterConfigsPackage(config: PackageConfig): boolean {
  return (
    config.isWillBoosterConfigs &&
    !config.isRoot &&
    config.packageJson?.private !== true &&
    Array.isArray(config.packageJson?.files) &&
    config.packageJson.files.length > 0
  );
}
