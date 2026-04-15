import type { PackageConfig } from '../packageConfig.js';

export function doesContainJsOrTs(config: PackageConfig): boolean {
  return (
    config.doesContainJavaScript ||
    config.doesContainJavaScriptInPackages ||
    config.doesContainTypeScript ||
    config.doesContainTypeScriptInPackages
  );
}
