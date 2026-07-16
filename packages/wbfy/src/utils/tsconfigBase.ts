import type { PackageConfig } from '../packageConfig.js';

export const managedTsconfigBaseDependencies = [
  '@tsconfig/bun',
  '@tsconfig/node-lts',
  '@tsconfig/node-ts',
  '@tsconfig/react-native',
];

export function getTsconfigExtends(config: PackageConfig): string | string[] {
  // React Native needs Metro-compatible settings (jsx: react-native, node resolution), which
  // @tsconfig/bun would override even though the repo uses Bun as its package manager.
  if (config.depending.reactNative) {
    return '@tsconfig/react-native/tsconfig.json';
  }
  return '@tsconfig/bun/tsconfig.json';
}

export function getTsconfigBaseDependencies(config: PackageConfig): string[] {
  if (config.depending.blitz || config.depending.next) {
    return [];
  }
  if (config.depending.reactNative) {
    return ['@tsconfig/react-native'];
  }
  return ['@tsconfig/bun'];
}
