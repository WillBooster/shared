import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';
import { promisePool } from '../utils/promisePool.js';

export async function generateReleaserc(rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateReleaserc', async () => {
    const filePath = path.resolve(rootConfig.dirPath, '.releaserc.json');
    if (!fs.existsSync(filePath)) return;

    const settings = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as {
      plugins?: (string | [string, unknown])[];
    };
    const plugins = settings.plugins ?? [];
    for (let i = 0; i < plugins.length; i++) {
      const pluginEntry = plugins[i];
      const isArray = Array.isArray(pluginEntry);
      const plugin = isArray ? pluginEntry[0] : pluginEntry;
      const oldConfig = (isArray && pluginEntry[1]) || {};
      if (plugin === '@semantic-release/commit-analyzer') {
        plugins[i] = [
          '@semantic-release/commit-analyzer',
          merge.all(
            [
              oldConfig,
              {
                preset: 'conventionalcommits',
              },
            ],
            { arrayMerge: overwriteMerge }
          ),
        ];
      } else if (plugin === '@semantic-release/github') {
        plugins[i] = [
          '@semantic-release/github',
          merge.all(
            [
              oldConfig,
              {
                // cf. https://github.com/semantic-release/semantic-release/issues/2204#issuecomment-1508417704
                successCommentCondition: false,
                failCommentCondition: false,
                labels: ['r: semantic-release'],
                releasedLabels: ['released :bookmark:'],
              },
            ],
            { arrayMerge: overwriteMerge }
          ),
        ];
      }
    }
    const newContent = JSON.stringify(settings, undefined, 2);
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}
