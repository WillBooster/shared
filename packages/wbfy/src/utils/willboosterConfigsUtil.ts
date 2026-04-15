import type { PackageConfig } from '../packageConfig.js';

const WILLBOOSTER_CONFIG_PACKAGE_NAMES = new Set(['@willbooster/oxlint-config', '@willbooster/prettier-config']);

export function shouldSkipWillboosterConfigsPackage(config: PackageConfig): boolean {
  const packageName = config.packageJson?.name;
  return (
    config.isWillBoosterConfigs && typeof packageName === 'string' && WILLBOOSTER_CONFIG_PACKAGE_NAMES.has(packageName)
  );
}
