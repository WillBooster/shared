import type { PackageConfig } from '../packageConfig.js';

const WBFY_OWNED_CONFIG_PACKAGE_NAMES = new Set([
  '@willbooster/oxfmt-config',
  '@willbooster/oxlint-config',
  '@willbooster/prettier-config',
]);

export function shouldSkipWillboosterConfigsPackage(config: PackageConfig): boolean {
  const packageName = config.packageJson?.name;
  return (
    config.isWillBoosterConfigs && typeof packageName === 'string' && WBFY_OWNED_CONFIG_PACKAGE_NAMES.has(packageName)
  );
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
