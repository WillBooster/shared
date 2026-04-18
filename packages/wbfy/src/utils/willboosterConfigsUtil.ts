import type { PackageConfig } from '../packageConfig.js';

export function isPublishedWillboosterConfigsPackage(config: PackageConfig): boolean {
  return (
    config.isWillBoosterConfigs &&
    !config.isRoot &&
    config.packageJson?.private !== true &&
    Array.isArray(config.packageJson?.files) &&
    config.packageJson.files.length > 0
  );
}
