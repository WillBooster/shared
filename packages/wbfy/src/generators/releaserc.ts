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
    let plugins = settings.plugins ?? [];
    // A private package without publishConfig releases only to GitHub (e.g. a deployed web app),
    // so a leftover npm plugin is dead configuration from a published-package template — but only
    // when the plugin provably publishes nothing: an entry that publishes the root keeps working
    // because generatePackageJson later removes the stale `private` flag for exactly that shape
    // (npmPublishesRoot), and a pkgRoot entry publishes another manifest regardless of the root's
    // privacy, so both must be kept.
    if (
      rootConfig.packageJson?.private &&
      !rootConfig.packageJson.publishConfig &&
      !rootConfig.release.npmPublishesRoot
    ) {
      plugins = plugins.filter((pluginEntry) => {
        const pluginName = Array.isArray(pluginEntry) ? pluginEntry[0] : pluginEntry;
        if (pluginName !== '@semantic-release/npm') return true;
        const options = (Array.isArray(pluginEntry) && (pluginEntry[1] as Record<string, unknown>)) || {};
        return typeof options.pkgRoot === 'string' && options.npmPublish !== false;
      });
      settings.plugins = plugins;
    }
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
        // successCommentCondition/failCommentCondition below supersede these deprecated options;
        // keeping both makes semantic-release warn and the config ambiguous.
        delete (oldConfig as Record<string, unknown>).successComment;
        delete (oldConfig as Record<string, unknown>).failComment;
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
