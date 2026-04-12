import fs from 'node:fs';
import path from 'node:path';

import type { ConfigurationValueMap } from '@yarnpkg/core';
import yaml from 'js-yaml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { promisePool } from '../utils/promisePool.js';
import { spawnSync, spawnSyncAndReturnStdout } from '../utils/spawnUtil.js';

type Settings = {
  defaultSemverRangePrefix: string;
  nmMode: string;
  nodeLinker: string;
  npmMinimalAgeGate?: string;
  npmPreapprovedPackages?: string[];
  plugins?: Plugin[];
} & Partial<ConfigurationValueMap>;

interface Plugin {
  checksum: string;
  path: string;
  spec: string;
}

export async function generateYarnrcYml(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateYarnrcYml', async () => {
    const yarnrcYmlPath = path.resolve(config.dirPath, '.yarnrc.yml');
    if (config.isBun) {
      await promisePool.run(() => fs.promises.rm(yarnrcYmlPath, { force: true }));
      await promisePool.run(() =>
        fs.promises.rm(path.resolve(config.dirPath, '.yarn'), { force: true, recursive: true })
      );
      await promisePool.run(() =>
        fs.promises.rm(path.resolve(config.dirPath, 'yarn.lock'), { force: true, recursive: true })
      );
      return;
    }

    const currentVersion = spawnSyncAndReturnStdout('yarn', ['--version'], config.dirPath);
    const latestVersion = getLatestVersion('@yarnpkg/cli', config.dirPath);
    if (getMajorNumber(currentVersion) <= getMajorNumber(latestVersion) && currentVersion !== latestVersion) {
      spawnSync('yarn', ['set', 'version', latestVersion], config.dirPath, 1);
    }

    const releasesPath = path.join(config.dirPath, '.yarn', 'releases');
    await fs.promises.mkdir(releasesPath, { recursive: true });
    for (const file of await fs.promises.readdir(releasesPath)) {
      if (file.startsWith('yarn-') && !file.startsWith(`yarn-${latestVersion}.`)) {
        await promisePool.run(() => fs.promises.rm(path.join(releasesPath, file)));
        console.log('Removed', path.join(releasesPath, file));
      }
    }

    const yarnrcPath = path.resolve(config.dirPath, '.yarnrc');
    await promisePool.run(() => fs.promises.rm(yarnrcPath, { force: true }));

    const settings = yaml.load(await fs.promises.readFile(yarnrcYmlPath, 'utf8')) as Settings;
    settings.defaultSemverRangePrefix = '';
    settings.nodeLinker = 'node-modules';
    settings.nmMode = 'hardlinks-global';
    settings.npmMinimalAgeGate = '5d';
    settings.npmPreapprovedPackages = [
      // We believe we are safe
      '@exercode/*',
      '@willbooster/*',
      'agent-runtime-kit',
      // To deal with CVE like https://nextjs.org/blog/CVE-2025-66478
      'next',
      '@next/*',
      'react',
      'react-dom',
    ];
    delete settings.compressionLevel;
    if (settings.injectEnvironmentFiles?.length === 0) {
      delete settings.injectEnvironmentFiles;
    }
    // cf. https://github.com/yarnpkg/berry/pull/4698
    settings.enableGlobalCache = true;
    const originalLength = settings.plugins?.length ?? 0;
    settings.plugins = settings.plugins?.filter((p) => p.path !== '.yarn/plugins/undefined.cjs') ?? [];
    if (settings.plugins.length !== originalLength) {
      const pluginPath = path.resolve(config.dirPath, '.yarn', 'plugins', 'undefined.cjs');
      await promisePool.run(() => fs.promises.rm(pluginPath, { force: true }));
    }
    if (settings.plugins.length === 0) {
      delete settings.plugins;
    }
    await fs.promises.writeFile(yarnrcYmlPath, yaml.dump(settings, { lineWidth: -1 }));

    spawnSync('yarn', ['dlx', 'yarn-plugin-auto-install'], config.dirPath);
  });
}

export function getLatestVersion(packageName: string, dirPath: string): string {
  const versionsJson = spawnSyncAndReturnStdout('npm', ['show', packageName, 'versions', '--json'], dirPath);
  return (
    versionsJson
      .match(/"([^"]+)"/gu)
      ?.at(-1)
      ?.slice(1, -1) ?? '0.0.0'
  );
}
function getMajorNumber(version: string): number {
  const [major] = version.split('.');
  return Number(major);
}
