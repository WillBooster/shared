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
  venvPath: '.',
  venv: '.venv',
};

export async function generatePyrightConfigJson(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generatePyrightConfigJson', async () => {
    let newSettings: object = structuredClone(jsonObj);
    const filePath = path.resolve(config.dirPath, 'pyrightconfig.json');
    const oldContent = await fsUtil.readFileIfExists(filePath);
    let originalSettingsJson: string | undefined;
    if (oldContent !== undefined && !jsoncUtil.isTriviaOnly(oldContent)) {
      // pyrightconfig.json allows JSONC; an existing file wbfy cannot parse must be left
      // untouched instead of being overwritten with the bare template.
      const oldSettings = jsoncUtil.parseObjectIgnoringError<object>(oldContent);
      if (!oldSettings) {
        console.warn(`Skipped generating ${filePath} because the existing content is not parsable as JSONC.`);
        return;
      }
      originalSettingsJson = JSON.stringify(sortKeys(structuredClone(oldSettings) as Record<string, unknown>));
      newSettings = merge.all([newSettings, oldSettings, newSettings], { arrayMerge: overwriteMerge });
    }
    // Skip the write when nothing changes semantically, so JSONC comments and formatting in an
    // already-clean pyrightconfig.json survive wbfy runs.
    if (originalSettingsJson === JSON.stringify(sortKeys(structuredClone(newSettings) as Record<string, unknown>))) {
      return;
    }
    const newContent = JSON.stringify(newSettings, undefined, 2);
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}
