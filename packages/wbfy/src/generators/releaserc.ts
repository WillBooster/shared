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
    // when the plugin provably publishes nothing. Two shapes still publish and must be kept: a
    // MONOREPO root whose entry publishes the root (generatePackageJson later removes the stale
    // `private` flag for exactly that shape — it never un-privates a single-package root, where
    // `@semantic-release/npm` skips publishing for private manifests anyway), and a pkgRoot entry
    // publishing another manifest regardless of the root's privacy (kept in the filter below).
    // Only an EXPLICIT plugin array is filtered: assigning to an omitted `plugins` would replace
    // semantic-release's default plugin list (which includes the GitHub release plugin) with an
    // empty one, and the default npm plugin already skips private manifests.
    // With @semantic-release/git present, the npm plugin's prepare step (which bumps
    // package.json's version even with npmPublish: false) feeds the committed release metadata,
    // so the entry is load-bearing regardless of privacy. The same applies whenever any OTHER
    // plugin configuration references the manifest the prepare step rewrites (e.g. a GitHub
    // release uploading package.json as an asset) — checked conservatively over the serialized
    // remaining configuration.
    const otherPluginsJson = JSON.stringify(
      plugins.filter(
        (pluginEntry) => (Array.isArray(pluginEntry) ? pluginEntry[0] : pluginEntry) !== '@semantic-release/npm'
      )
    );
    const keepsPreparedManifest =
      otherPluginsJson.includes('@semantic-release/git') ||
      otherPluginsJson.includes('package.json') ||
      otherPluginsJson.includes('npm-shrinkwrap.json');
    if (
      Array.isArray(settings.plugins) &&
      !keepsPreparedManifest &&
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
        // A pkgRoot entry acts on another manifest even with npmPublish: false (its prepare step
        // still bumps that manifest's version), so keep it regardless of the publish setting.
        return typeof options.pkgRoot === 'string';
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
