import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';
import { sortKeys } from '../utils/objectUtil.js';
import { promisePool } from '../utils/promisePool.js';

const jsonObj = {
  $schema: 'https://docs.renovatebot.com/renovate-schema.json',
  extends: ['github>WillBooster/willbooster-configs:renovate.json5'],
};

type Settings = Omit<typeof jsonObj, 'extends'> & {
  extends?: string[];
  packageRules?: { matchPackageNames: string[]; enabled?: boolean }[];
};

export async function generateRenovateJson(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateRenovateJson', async () => {
    let newSettings = structuredClone(jsonObj) as Settings;
    const filePath = path.resolve(config.dirPath, 'renovate.json');
    // Renovate reads only the first matching config file (renovate.json wins over these variants),
    // so generating renovate.json next to one of them would silently shadow the user's config.
    if (
      ['renovate.jsonc', 'renovate.json5'].some((fileName) => fs.existsSync(path.resolve(config.dirPath, fileName)))
    ) {
      return;
    }
    const oldContent = await fsUtil.readFileIfExists(filePath);
    let originalSettingsJson: string | undefined;
    if (oldContent !== undefined && !jsoncUtil.isTriviaOnly(oldContent)) {
      // Renovate accepts JSONC in renovate.json; an existing file wbfy cannot parse must be left
      // untouched instead of being overwritten with the bare template.
      const oldSettings = jsoncUtil.parseObjectIgnoringError<Settings>(oldContent);
      if (!oldSettings) {
        console.warn(`Skipped generating ${filePath} because the existing content is not parsable as JSONC.`);
        return;
      }
      originalSettingsJson = JSON.stringify(sortKeys(structuredClone(oldSettings) as Record<string, unknown>));
      newSettings = merge.all([newSettings, oldSettings, newSettings], {
        arrayMerge: overwriteMerge,
      }) as Settings;
      newSettings.extends = mergeRenovateExtends(jsonObj.extends, oldSettings.extends ?? []);
    }

    // Don't upgrade Next.js automatically
    if (config.depending.blitz) {
      newSettings.packageRules ??= [];
      if (
        !newSettings.packageRules.some((rule: { matchPackageNames?: string[] }) =>
          rule.matchPackageNames?.includes('next')
        )
      ) {
        newSettings.packageRules.push({ matchPackageNames: ['next'], enabled: false });
      }
    }

    await promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.dependabot'), { force: true }));
    await promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.renovaterc.json'), { force: true }));
    // Skip the write when nothing changes semantically, so JSONC comments and formatting in an
    // already-clean renovate.json survive wbfy runs.
    if (originalSettingsJson === JSON.stringify(sortKeys(structuredClone(newSettings) as Record<string, unknown>))) {
      return;
    }
    const newContent = JSON.stringify(newSettings, undefined, 2);
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}

function mergeRenovateExtends(generatedExtends: string[], existingExtends: string[]): string[] {
  return [...new Set([...generatedExtends, ...existingExtends])].filter((item) => item !== '@willbooster');
}
