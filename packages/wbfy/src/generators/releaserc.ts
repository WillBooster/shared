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
    // when the plugin provably publishes nothing AND no other plugin consumes the manifest its
    // prepare step still rewrites (npm bumps package.json's version even with npmPublish: false).
    // Because arbitrary plugins/commands can consume that manifest indirectly, removal is limited
    // to the KNOWN-SAFE released-web-app template shape: every other plugin is one of the standard
    // analysis/notes/github plugins, and the github plugin uploads no assets (an assets glob could
    // be the prepared manifest). Any exec/git/custom plugin means keep npm. Two npm shapes still
    // publish and are kept even in that template (filter below): a MONOREPO root whose entry
    // publishes the root (generatePackageJson later un-privates exactly that shape — never a
    // single-package root, where npm skips private manifests anyway) and a pkgRoot entry acting on
    // another manifest. Only an EXPLICIT plugin array is filtered: assigning to an omitted
    // `plugins` would replace semantic-release's defaults (which include the GitHub plugin).
    const standardNonPublishingPlugins = new Set([
      '@semantic-release/commit-analyzer',
      '@semantic-release/release-notes-generator',
      '@semantic-release/github',
    ]);
    const everyOtherPluginIsStandardNonPublishing = plugins.every((pluginEntry) => {
      const pluginName = Array.isArray(pluginEntry) ? pluginEntry[0] : pluginEntry;
      if (pluginName === '@semantic-release/npm') return true;
      if (typeof pluginName !== 'string' || !standardNonPublishingPlugins.has(pluginName)) return false;
      // A github plugin uploading assets could publish the prepared manifest, so it is not "safe".
      const options = (Array.isArray(pluginEntry) && (pluginEntry[1] as Record<string, unknown>)) || {};
      return !(pluginName === '@semantic-release/github' && options.assets !== undefined);
    });
    if (
      Array.isArray(settings.plugins) &&
      everyOtherPluginIsStandardNonPublishing &&
      rootConfig.packageJson?.private &&
      !rootConfig.packageJson.publishConfig &&
      !(rootConfig.doesContainSubPackageJsons && rootConfig.release.npmPublishesRoot)
    ) {
      plugins = plugins.filter((pluginEntry) => {
        const pluginName = Array.isArray(pluginEntry) ? pluginEntry[0] : pluginEntry;
        if (pluginName !== '@semantic-release/npm') return true;
        const options = (Array.isArray(pluginEntry) && (pluginEntry[1] as Record<string, unknown>)) || {};
        // tarballDir entries still produce release assets even with npmPublish: false.
        if (typeof options.tarballDir === 'string') return true;
        // A pkgRoot entry pointing at ANOTHER manifest acts on it even with npmPublish: false (its
        // prepare step still bumps that manifest's version), so keep it. But `.`/`./` is the root
        // manifest itself (@semantic-release/npm's default), equivalent to the bare string form
        // that is removable, so it does not count.
        return (
          typeof options.pkgRoot === 'string' && path.posix.normalize(options.pkgRoot).replace(/\/+$/u, '') !== '.'
        );
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
