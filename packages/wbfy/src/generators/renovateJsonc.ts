import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';

const sharedPreset = 'github>WillBooster/willbooster-configs:renovate.jsonc';
// The preset without the private-registry hostRules of `sharedPreset`, which repositories outside the
// WillBooster organizations cannot resolve.
const baseSharedPreset = 'github>WillBooster/willbooster-configs:renovate-base.jsonc';
const sharedPresets = new Set([sharedPreset, baseSharedPreset]);
const generatedSettings = {
  $schema: 'https://docs.renovatebot.com/renovate-schema.json',
  extends: [sharedPreset],
};

interface PackageRule {
  matchPackageNames?: string[];
  matchFileNames?: string[];
  allowedVersions?: string;
  description?: string;
}

type Settings = Partial<typeof generatedSettings> & { packageRules?: PackageRule[] };

const managedFileName = 'renovate.jsonc';
const blitzNextRuleDescription = 'Keep Blitz apps on Next.js 15';
// Earlier wbfy versions also grouped `@vitejs/plugin-react` with `oxc-transform-react` and pinned the latter to the
// former's peer range. Only that range's lower bound matters, and an up-to-date `oxc-transform-react` always meets it,
// so the rules only held updates back. Their descriptions stay here so that wbfy removes them.
const managedRuleDescriptions = new Set([
  blitzNextRuleDescription,
  '@vitejs/plugin-react peer-requires a single minor of oxc-transform-react, which Renovate does not check, so update both together and review them by hand',
  'Keep oxc-transform-react within the peer range of the installed @vitejs/plugin-react',
]);

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

export async function generateRenovateJsonc(
  config: PackageConfig,
  allPackageConfigs: PackageConfig[] = [config]
): Promise<void> {
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

    if (oldSettings?.extends !== undefined && !Array.isArray(oldSettings.extends)) {
      console.warn(`Skipped generating ${filePath} because "extends" is not an array.`);
      return;
    }
    const removedPreset = oldSettings?.extends?.find(
      (preset) => preset.startsWith('github>WillBooster/willbooster-configs:') && !sharedPresets.has(preset)
    );
    if (removedPreset) {
      console.warn(`Skipped generating ${filePath} because "${removedPreset}" no longer exists; remove it manually.`);
      return;
    }

    const newSettings = buildSettings(config, allPackageConfigs, oldSettings);
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

function buildSettings(
  config: PackageConfig,
  allPackageConfigs: PackageConfig[],
  oldSettings: Settings | undefined
): Settings {
  const settings: Settings = oldSettings
    ? (merge.all([generatedSettings, oldSettings, generatedSettings], {
        arrayMerge: overwriteMerge,
      }) as Settings)
    : structuredClone(generatedSettings);
  const existingExtends = oldSettings?.extends ?? [];
  settings.extends = config.isWillBoosterConfigs
    ? existingExtends.filter((preset) => preset !== sharedPreset)
    : existingExtends.some((preset) => sharedPresets.has(preset))
      ? existingExtends
      : [config.repository && !config.isWillBoosterRepo ? baseSharedPreset : sharedPreset, ...existingExtends];
  const managedRules: PackageRule[] = [];
  const blitzManifestPaths = allPackageConfigs
    .filter((packageConfig) => packageConfig.depending.blitz)
    .map((packageConfig) => path.relative(config.dirPath, path.join(packageConfig.dirPath, 'package.json')));
  if (blitzManifestPaths.length > 0) {
    managedRules.push({
      description: blitzNextRuleDescription,
      matchPackageNames: ['next'],
      matchFileNames: blitzManifestPaths,
      allowedVersions: '15.x',
    });
  }
  const packageRules = replaceDuplicatePackageRules(settings.packageRules ?? [], managedRules);
  // An `undefined` value, unlike a deleted key, makes jsoncUtil.stringifyPreservingTrivia remove the property.
  settings.packageRules = packageRules.length > 0 ? packageRules : undefined;
  return settings;
}

/**
 * Replaces with the managed rules each existing rule that duplicates one: wbfy's earlier output (by description) and any
 * rule selecting exactly a managed rule's package names and file names with no other selector. Other rules are kept in
 * order, and the managed rules come last because Renovate lets a later matching rule override an earlier one.
 */
function replaceDuplicatePackageRules(existingRules: PackageRule[], managedRules: PackageRule[]): PackageRule[] {
  const keptRules = existingRules.filter(
    (rule) => !isManagedRule(rule) && !managedRules.some((managedRule) => duplicates(rule, managedRule))
  );
  return [...keptRules, ...managedRules];
}

function duplicates(rule: PackageRule, managedRule: PackageRule): boolean {
  const hasOtherSelector = Object.keys(rule).some(
    (key) => isSelector(key) && key !== 'matchPackageNames' && key !== 'matchFileNames'
  );
  return (
    !hasOtherSelector &&
    haveSameElements(rule.matchPackageNames ?? [], managedRule.matchPackageNames ?? []) &&
    haveSameElements(rule.matchFileNames ?? [], managedRule.matchFileNames ?? [])
  );
}

function isSelector(key: string): boolean {
  return /^(match|exclude)[A-Z]/u.test(key);
}

function isManagedRule(rule: PackageRule): boolean {
  return rule.description !== undefined && managedRuleDescriptions.has(rule.description);
}

function haveSameElements(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  return leftSet.size === new Set(right).size && right.every((element) => leftSet.has(element));
}

function normalize(content: string): string {
  const trimmedContent = content.trim();
  return trimmedContent ? trimmedContent + '\n' : '';
}
