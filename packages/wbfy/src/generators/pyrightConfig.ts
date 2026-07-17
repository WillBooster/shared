import path from 'node:path';

import merge from 'deepmerge';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';
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
    if (oldContent !== undefined && oldContent.trim()) {
      // pyrightconfig.json allows JSONC; an existing file wbfy cannot parse must be left
      // untouched instead of being overwritten with the bare template.
      const oldSettings = jsoncUtil.parseObjectIgnoringError<object>(oldContent);
      if (!oldSettings) {
        console.warn(`Skipped generating ${filePath} because the existing content is not parsable as JSONC.`);
        return;
      }
      newSettings = merge.all([newSettings, oldSettings, newSettings], { arrayMerge: overwriteMerge });
    }
    const newContent = JSON.stringify(newSettings, undefined, 2);
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}
