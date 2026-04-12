import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import cloneDeep from 'lodash.clonedeep';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';
import { promisePool } from '../utils/promisePool.js';

const jsonObj = {
  $schema: 'https://docs.renovatebot.com/renovate-schema.json',
  extends: ['github>WillBooster/willbooster-configs:renovate.json5'],
};

type Settings = typeof jsonObj & { packageRules?: { matchPackageNames: string[]; enabled?: boolean }[] };

export async function generateRenovateJson(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateRenovateJson', async () => {
    let newSettings = cloneDeep(jsonObj) as Settings;
    const filePath = path.resolve(config.dirPath, 'renovate.json');
    if (fs.existsSync(`${filePath}5`)) {
      // Since it is difficult for parsing renovate.json5, we do nothing
      return;
    }
    try {
      const oldContent = await fs.promises.readFile(filePath, 'utf8');
      const oldSettings = JSON.parse(oldContent) as Settings;
      newSettings = merge.all([newSettings, oldSettings, newSettings], {
        arrayMerge: overwriteMerge,
      }) as Settings;
      newSettings.extends = newSettings.extends.filter((item: string) => item !== '@willbooster');
    } catch {
      // do nothing
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
    const newContent = JSON.stringify(newSettings);
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}
