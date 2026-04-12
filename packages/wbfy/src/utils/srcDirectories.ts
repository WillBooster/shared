import type { PackageConfig } from '../packageConfig.js';

const srcDirectories = {
  node: ['src', 'test', 'scripts'].toSorted(),
  blitz: ['src', 'test', 'scripts', 'db', 'integrations', 'mailers'].toSorted(),
};

export function getSrcDirs(config: PackageConfig): string[] {
  if (config.depending.blitz) {
    return srcDirectories.blitz;
  }
  return srcDirectories.node;
}
