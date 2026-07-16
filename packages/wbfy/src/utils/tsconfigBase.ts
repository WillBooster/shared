import type { PackageConfig } from '../packageConfig.js';

export const managedTsconfigBaseDependencies = [
  '@tsconfig/bun',
  '@tsconfig/node-lts',
  '@tsconfig/node-ts',
  '@tsconfig/react-native',
];

export function getTsconfigExtends(): string | string[] {
  return '@tsconfig/bun/tsconfig.json';
}

export function getTsconfigBaseDependencies(config: PackageConfig): string[] {
  if (config.depending.blitz || config.depending.next) {
    return [];
  }
  return ['@tsconfig/bun'];
}
