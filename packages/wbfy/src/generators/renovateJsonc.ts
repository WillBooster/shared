import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';

import { enablesViteReactCompiler } from '../fixers/viteConfig.js';
import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';
import { getOxcTransformReactPeerRange, oxcTransformReactDependency } from '../utils/vitePluginReact.js';

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
  enabled?: boolean;
  allowedVersions?: string;
  description?: string;
  groupName?: string;
  groupSlug?: string;
  automerge?: boolean;
  prBodyNotes?: string[];
  [key: string]: unknown;
}

type Settings = Partial<typeof generatedSettings> & { packageRules?: PackageRule[] };

const managedFileName = 'renovate.jsonc';
const blitzNextRuleDescription = 'Keep Blitz apps on Next.js 15';
const reactCompilerGroupRuleDescription =
  '@vitejs/plugin-react peer-requires a single minor of oxc-transform-react, which Renovate does not check, so update both together and review them by hand';
const oxcTransformReactPinRuleDescription =
  'Keep oxc-transform-react within the peer range of the installed @vitejs/plugin-react';
const managedRuleDescriptions = new Set([
  blitzNextRuleDescription,
  reactCompilerGroupRuleDescription,
  oxcTransformReactPinRuleDescription,
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

    const newSettings = buildSettings(
      config,
      allPackageConfigs,
      await getReactCompilerPeerRange(allPackageConfigs),
      oldSettings
    );
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

async function getReactCompilerPeerRange(allPackageConfigs: PackageConfig[]): Promise<string | undefined> {
  const vinextConfigs = allPackageConfigs.filter((packageConfig) => packageConfig.depending.vinext);
  const enabled = await Promise.all(vinextConfigs.map((packageConfig) => enablesViteReactCompiler(packageConfig)));
  const reactCompilerConfig = vinextConfigs.find((_, index) => enabled[index]);
  return reactCompilerConfig && getOxcTransformReactPeerRange(reactCompilerConfig.dirPath);
}

function buildSettings(
  config: PackageConfig,
  allPackageConfigs: PackageConfig[],
  reactCompilerPeerRange: string | undefined,
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
  if (reactCompilerPeerRange) {
    managedRules.push(
      {
        description: reactCompilerGroupRuleDescription,
        groupName: 'React Compiler',
        groupSlug: 'react-compiler',
        matchPackageNames: ['@vitejs/plugin-react', oxcTransformReactDependency],
        automerge: false,
        // The pin below holds oxc-transform-react back when @vitejs/plugin-react moves to a new peer range.
        prBodyNotes: [
          'Update `oxc-transform-react` and its `allowedVersions` in `renovate.jsonc` to the range the new `@vitejs/plugin-react` declares in `peerDependencies`.',
        ],
      },
      {
        description: oxcTransformReactPinRuleDescription,
        matchPackageNames: [oxcTransformReactDependency],
        allowedVersions: reactCompilerPeerRange,
      }
    );
  }
  const packageRules = mergePackageRules(settings.packageRules ?? [], managedRules);
  if (packageRules.length > 0 || settings.packageRules) settings.packageRules = packageRules;
  return settings;
}

/**
 * Merges into each managed rule the existing rules that target the same packages: those with its description, and those
 * selecting exactly its package names and file names with no other selector. The managed rule's selectors and values win
 * over theirs, so a repository never carries a duplicate of a managed rule; other existing rules are kept in order, and
 * managed rules that are no longer generated are removed.
 */
function mergePackageRules(existingRules: PackageRule[], managedRules: PackageRule[]): PackageRule[] {
  const absorbedRules = new Map<PackageRule, PackageRule>();
  const keptRules = existingRules.filter((rule) => {
    const managedRule = managedRules.find((candidate) => targetsSamePackages(rule, candidate));
    if (managedRule) absorbedRules.set(managedRule, { ...absorbedRules.get(managedRule), ...rule });
    return !managedRule && !isManagedRule(rule);
  });
  // Renovate lets a later matching rule override an earlier one, so the managed rules come last.
  return [
    ...keptRules,
    ...managedRules.map((managedRule) => mergeRule(absorbedRules.get(managedRule) ?? {}, managedRule, managedRules)),
  ];
}

function targetsSamePackages(rule: PackageRule, managedRule: PackageRule): boolean {
  if (rule.description === managedRule.description) return true;
  if (isManagedRule(rule)) return false;
  const hasOtherSelector = Object.keys(rule).some(
    (key) => isSelector(key) && key !== 'matchPackageNames' && key !== 'matchFileNames'
  );
  return (
    !hasOtherSelector &&
    haveSameElements(rule.matchPackageNames ?? [], managedRule.matchPackageNames ?? []) &&
    haveSameElements(rule.matchFileNames ?? [], managedRule.matchFileNames ?? [])
  );
}

/**
 * The merged rule keeps only the absorbed settings that no managed rule sets (e.g. `schedule`): managed rules overlap
 * (the React Compiler group and the oxc-transform-react pin), so an absorbed `automerge` or `groupName` on one would
 * override the other's, and an absorbed selector would narrow it. Keys keep the existing rule's order, so a rerun
 * rewrites nothing.
 */
function mergeRule(rule: PackageRule, managedRule: PackageRule, managedRules: PackageRule[]): PackageRule {
  return Object.fromEntries(
    Object.entries({ ...rule, ...managedRule }).filter(
      ([key]) => key in managedRule || (!isSelector(key) && managedRules.every((other) => !(key in other)))
    )
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
