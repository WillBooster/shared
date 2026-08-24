import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';

const sharedPreset = 'github>WillBooster/willbooster-configs:renovate.jsonc';
const generatedSettings = {
  $schema: 'https://docs.renovatebot.com/renovate-schema.json',
  extends: [sharedPreset],
};

type Settings = Partial<typeof generatedSettings> & {
  packageRules?: { matchPackageNames: string[]; enabled?: boolean }[];
};

const managedFileName = 'renovate.jsonc';

// wbfy supports one canonical Renovate location. Non-canonical configs are fixed in the target
// repository instead of being parsed, merged, or deleted here.
const nonCanonicalConfigPaths = [
  'renovate.json',
  'renovate.json5',
  '.github/renovate.json',
  '.github/renovate.jsonc',
  '.github/renovate.json5',
  '.renovaterc',
  '.renovaterc.json',
  '.renovaterc.json5',
];

export async function generateRenovateJsonc(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateRenovateJsonc', async () => {
    const filePath = path.resolve(config.dirPath, managedFileName);
    const managedFileStats = await fs.promises.lstat(filePath).catch(() => {});
    if (managedFileStats?.isSymbolicLink()) {
      console.warn(`Skipped generating ${filePath} because it is a symbolic link.`);
      return;
    }

    const nonCanonicalConfigCandidates = await Promise.all(
      nonCanonicalConfigPaths.map(async (relativePath) => {
        const candidate = path.resolve(config.dirPath, relativePath);
        return (await fs.promises.lstat(candidate).catch(() => {})) ? candidate : undefined;
      })
    );
    const nonCanonicalConfigPath = nonCanonicalConfigCandidates.find((candidate) => candidate !== undefined);
    if (nonCanonicalConfigPath || config.packageJson?.renovate) {
      console.warn(
        `Skipped generating ${filePath} because the repository has a non-canonical Renovate config${
          nonCanonicalConfigPath ? ` at ${nonCanonicalConfigPath}` : ' in package.json'
        }.`
      );
      return;
    }

    const oldContent = await fsUtil.readFileIfExists(filePath);
    let oldSettings: Settings | undefined;
    if (oldContent !== undefined && !jsoncUtil.isTriviaOnly(oldContent)) {
      oldSettings = jsoncUtil.parseObjectIgnoringError<Settings>(oldContent);
      if (!oldSettings) {
        console.warn(`Skipped generating ${filePath} because the existing content is not parsable as JSONC.`);
        return;
      }
    }

    const newSettings = buildSettings(config, oldSettings);
    const { content, keysLosingComments } = jsoncUtil.stringifyPreservingTrivia(
      oldContent,
      newSettings as Record<string, unknown>
    );
    if (oldContent !== undefined && normalize(content) === normalize(oldContent)) return;
    if (!(await fsUtil.generateFile(filePath, content))) return;

    for (const key of keysLosingComments) {
      console.warn(`Comments inside "${key}" were dropped while rewriting it in ${filePath}.`);
    }
  });
}

function buildSettings(config: PackageConfig, oldSettings: Settings | undefined): Settings {
  const settings = oldSettings
    ? (merge.all([generatedSettings, oldSettings, generatedSettings], {
        arrayMerge: overwriteMerge,
      }) as Settings)
    : structuredClone(generatedSettings);
  const existingExtends = oldSettings?.extends ?? [];
  settings.extends = config.isWillBoosterConfigs
    ? existingExtends.filter((preset) => preset !== sharedPreset)
    : existingExtends.includes(sharedPreset)
      ? existingExtends
      : [sharedPreset, ...existingExtends];
  return settings;
}

function normalize(content: string): string {
  const trimmedContent = content.trim();
  return trimmedContent ? trimmedContent + '\n' : '';
}
