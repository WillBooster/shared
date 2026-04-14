import type { PackageConfig } from '../packageConfig.js';

const ESLINT_CONFIG_PREFIX = '@willbooster/eslint-config-';
const WILLBOOSTER_CONFIGS_REPO_SPECIFIER = 'github:WillBooster/willbooster-configs';
const pinnedDependencySpecifiers = {
  '@eslint/js': '^10.0.1',
  eslint: '^10.2.0',
  typescript: '^5.9.3',
} as const;

export function shouldSkipWillboosterConfigsEslintPackage(config: PackageConfig): boolean {
  return config.isWillBoosterConfigs && config.packageJson?.name?.startsWith(ESLINT_CONFIG_PREFIX) === true;
}

export function getPinnedDependencySpecifier(dependency: string): string | undefined {
  if (dependency.startsWith(ESLINT_CONFIG_PREFIX)) {
    return `${dependency}@${WILLBOOSTER_CONFIGS_REPO_SPECIFIER}#workspace=${dependency}`;
  }

  for (const [key, value] of Object.entries(pinnedDependencySpecifiers)) {
    if (key === dependency) {
      return `${key}@${value}`;
    }
  }

  return undefined;
}
