import type { PackageJson } from 'type-fest';

import type { PackageConfig } from '../packageConfig.js';

export function hasGenI18nTsScript(config: PackageConfig, scripts: PackageJson.Scripts | undefined): boolean {
  return config.depending.genI18nTs && !!scripts?.['gen-i18n-ts'];
}

export function getPackageManagerRunCommand(config: Pick<PackageConfig, 'isBun'>, scriptName: string): string {
  return `${config.isBun ? 'bun' : 'yarn'} run ${scriptName}`;
}
