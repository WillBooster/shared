import type { PackageJson } from 'type-fest';

import type { PackageConfig } from '../packageConfig.js';

export function getGenI18nTsCommand(
  config: Pick<PackageConfig, 'depending'>,
  scripts: PackageJson.Scripts | undefined
): string | undefined {
  if (!config.depending.genI18nTs || !scripts?.['gen-i18n-ts']) return undefined;
  return 'bun run gen-i18n-ts > /dev/null';
}
