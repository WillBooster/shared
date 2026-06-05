import type { PackageJson } from 'type-fest';

import type { PackageConfig } from '../packageConfig.js';

const defaultGenI18nTsScript = 'gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP';

export function getGenI18nTsCommand(
  config: Pick<PackageConfig, 'depending' | 'isBun'>,
  scripts: PackageJson.Scripts | undefined
): string | undefined {
  if (!config.depending.genI18nTs || !scripts?.['gen-i18n-ts']) return undefined;
  if (scripts['gen-i18n-ts'] === defaultGenI18nTsScript) return undefined;
  return `${config.isBun ? 'bun' : 'yarn'} run gen-i18n-ts > /dev/null`;
}
