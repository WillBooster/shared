import type { PackageConfig } from '../packageConfig.js';

const WILLBOOSTER_CONFIG_PACKAGE_NAMES = new Set(['@willbooster/oxlint-config', '@willbooster/prettier-config']);
const pinnedDependencySpecifiers = {
  oxlint: '^1.60.0',
  typescript: '^5.9.3',
} as const;

export function shouldSkipWillboosterConfigsPackage(config: PackageConfig): boolean {
  const packageName = config.packageJson?.name;
  return (
    config.isWillBoosterConfigs && typeof packageName === 'string' && WILLBOOSTER_CONFIG_PACKAGE_NAMES.has(packageName)
  );
}

export function getPinnedDependencySpecifier(dependency: string): string | undefined {
  for (const [key, value] of Object.entries(pinnedDependencySpecifiers)) {
    if (key === dependency) {
      return `${key}@${value}`;
    }
  }

  return undefined;
}
