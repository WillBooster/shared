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
  venvPath: '.',
  venv: '.venv',
};

export async function generatePyrightConfigJson(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generatePyrightConfigJson', async () => {
    let newSettings: object = cloneDeep(jsonObj);
    const filePath = path.resolve(config.dirPath, 'pyrightconfig.json');
    try {
      const oldContent = await fs.promises.readFile(filePath, 'utf8');
      const oldSettings = JSON.parse(oldContent) as object;
      newSettings = merge.all([newSettings, oldSettings, newSettings], { arrayMerge: overwriteMerge });
    } catch {
      // do nothing
    }
    const newContent = JSON.stringify(newSettings);
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}
