import type { PackageConfig } from '../packageConfig.js';

export function getTsconfigExtends(config: PackageConfig): string | string[] {
  if (config.isBun) {
    return '@tsconfig/bun/tsconfig.json';
  }
  if (config.depending.reactNative) {
    return '@tsconfig/react-native/tsconfig.json';
  }
  return ['@tsconfig/node-lts/tsconfig.json', '@tsconfig/node-ts/tsconfig.json'];
}

export function getTsconfigBaseDependencies(config: PackageConfig): string[] {
  if (config.isBun) {
    return ['@tsconfig/bun'];
  }
  if (config.depending.reactNative) {
    return ['@tsconfig/react-native'];
  }
  return ['@tsconfig/node-lts', '@tsconfig/node-ts'];
}
