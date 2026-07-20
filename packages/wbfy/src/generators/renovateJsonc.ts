import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import JSON5 from 'json5';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';
import { promisePool } from '../utils/promisePool.js';

const jsonObj = {
  $schema: 'https://docs.renovatebot.com/renovate-schema.json',
  extends: ['github>WillBooster/willbooster-configs:renovate.json5'],
};

// $schema is optional: an existing config need not declare it, and an empty or comment-only
// config file contributes no properties at all.
type Settings = Partial<Omit<typeof jsonObj, 'extends'>> & {
  // Renovate's schema allows a single preset string in addition to an array.
  extends?: string | string[];
  packageRules?: { matchPackageNames: string[]; enabled?: boolean }[];
};

// The managed file is renovate.jsonc rather than renovate.json: the settings carry explanatory
// comments (e.g. why a private registry is mapped), and a .jsonc extension states that up front
// instead of leaving a .json file that only Renovate's JSONC-tolerant parser accepts.
const managedFileName = 'renovate.jsonc';

// Renovate's documented resolution order (https://docs.renovatebot.com/configuration-options/).
// It stops at the FIRST file that exists, so only the highest-priority existing config is live and
// every other one is dead config whose settings must not be resurrected.
//
// - `managed`: the file wbfy writes.
// - `superseded`: consolidated into the managed file and deleted. Deleting them is what makes the
//   migration take effect for the ones that outrank renovate.jsonc.
// - `shadowed`: left alone. Generating renovate.jsonc beside a live one would shadow it, so wbfy
//   bails instead. The list stays platform-agnostic (e.g. .gitlab): wbfy manages GitHub-hosted
//   repositories, and bailing on another platform's config is a safe no-op, not a missed
//   generation.
//
// `jsonc` marks the syntax wbfy can both parse AND edit in place; a `json5` source can only be
// re-serialized, which drops its comments.
const configLocations = [
  { relativePath: 'renovate.json', role: 'superseded', isEditableSyntax: true },
  { relativePath: managedFileName, role: 'managed', isEditableSyntax: true },
  { relativePath: 'renovate.json5', role: 'superseded', isEditableSyntax: false },
  { relativePath: '.github/renovate.json', role: 'shadowed', isEditableSyntax: true },
  { relativePath: '.github/renovate.jsonc', role: 'shadowed', isEditableSyntax: true },
  { relativePath: '.github/renovate.json5', role: 'shadowed', isEditableSyntax: false },
  { relativePath: '.gitlab/renovate.json', role: 'shadowed', isEditableSyntax: true },
  { relativePath: '.gitlab/renovate.jsonc', role: 'shadowed', isEditableSyntax: true },
  { relativePath: '.gitlab/renovate.json5', role: 'shadowed', isEditableSyntax: false },
  { relativePath: '.renovaterc', role: 'shadowed', isEditableSyntax: true },
  { relativePath: '.renovaterc.json', role: 'superseded', isEditableSyntax: true },
  { relativePath: '.renovaterc.jsonc', role: 'shadowed', isEditableSyntax: true },
  { relativePath: '.renovaterc.json5', role: 'shadowed', isEditableSyntax: false },
] as const;

export async function generateRenovateJsonc(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateRenovateJsonc', async () => {
    const filePath = path.resolve(config.dirPath, managedFileName);
    // A symlinked renovate.jsonc is never managed: writes through it are refused by the
    // confinement guards anyway, and when its target happens to already match the generated
    // settings the no-op below would skip generateFile (and its guard) and proceed to delete the
    // superseded configs — leaving a fresh checkout with only a possibly-dangling external symlink
    // as Renovate configuration.
    const managedFileStats = await fs.promises.lstat(filePath).catch(() => {});
    if (managedFileStats && managedFileStats.isSymbolicLink()) {
      console.warn(`Skipped generating ${filePath} because it is a symbolic link.`);
      return;
    }

    const existingConfigs = await readExistingConfigs(config);
    if (existingConfigs === undefined) return;

    // Renovate reads only the highest-priority config, so it alone carries the live settings.
    // A shadowed one winning means renovate.jsonc would outrank (and silently replace) the config
    // currently in effect — including a `renovate` section in package.json, which every file
    // outranks and which wbfy cannot migrate.
    const liveConfig = existingConfigs[0];
    if (liveConfig?.role === 'shadowed') return;
    if (!liveConfig && config.packageJson?.['renovate']) return;

    const oldContent = existingConfigs.find((existing) => existing.role === 'managed')?.content;
    // Edit the live config in place so its comments and formatting survive. A JSON5 source cannot
    // be edited (jsonc-parser rejects unquoted keys and single-quoted strings) and is re-serialized
    // instead, which the warning below reports.
    const baseContent = liveConfig?.isEditableSyntax ? liveConfig.content : undefined;
    if (baseContent !== undefined && jsoncUtil.hasDuplicateTopLevelKey(baseContent)) {
      console.warn(`Skipped generating ${filePath} because ${liveConfig?.filePath} declares the same property twice.`);
      return;
    }

    const newSettings = buildSettings(config, liveConfig?.settings);
    const newContent = jsoncUtil.stringifyPreservingTrivia(baseContent, newSettings as Record<string, unknown>);
    // Compare against the managed file the same way generateFile normalizes its writes, so an
    // unchanged repository is left completely untouched. Await the write directly: the superseded
    // sources below must survive when the confinement guards refuse it (e.g. renovate.jsonc is a
    // dangling symlink).
    if (
      (oldContent === undefined || normalize(newContent) !== normalize(oldContent)) &&
      !(await fsUtil.generateFile(filePath, newContent))
    ) {
      return;
    }

    const supersededConfigs = existingConfigs.filter((existing) => existing.role === 'superseded');
    for (const superseded of supersededConfigs) {
      // Comments survive only when the source doubled as the editing base above.
      if (superseded.content !== baseContent && jsoncUtil.containsComment(superseded.content)) {
        console.warn(
          `Comments in ${superseded.filePath} were dropped while migrating it into ${filePath}; copy them over manually.`
        );
      }
    }
    await promisePool.run(() =>
      fsUtil.removeConfined(path.resolve(config.dirPath, '.dependabot'), { recursive: true })
    );
    // Remove the superseded configs once the managed file is in place (for a symlink this deletes
    // only the link entry). Even a dead one must go: it would otherwise keep occupying its slot in
    // the resolution order, and an empty renovate.json is enough to hide renovate.jsonc entirely.
    for (const superseded of supersededConfigs) {
      await promisePool.run(() => fsUtil.removeConfined(superseded.filePath));
    }
  });
}

/** Merges the generated settings on top of the live ones, leaving the live values in place. */
function buildSettings(config: PackageConfig, liveSettings: Settings | undefined): Settings {
  const generatedSettings = structuredClone(jsonObj) as Settings;
  const newSettings = liveSettings
    ? (merge.all([generatedSettings, liveSettings, generatedSettings], {
        arrayMerge: overwriteMerge,
      }) as Settings)
    : generatedSettings;
  newSettings.extends = mergeRenovateExtends(jsonObj.extends, liveSettings?.extends);

  // Don't upgrade Next.js automatically
  if (config.depending.blitz) {
    newSettings.packageRules ??= [];
    if (
      !newSettings.packageRules.some((rule: { matchPackageNames?: string[] }) =>
        rule.matchPackageNames?.includes('next')
      )
    ) {
      newSettings.packageRules.push({ matchPackageNames: ['next'], enabled: false });
    }
  }
  return newSettings;
}

interface ExistingConfig {
  filePath: string;
  content: string;
  settings: Settings;
  role: (typeof configLocations)[number]['role'];
  isEditableSyntax: boolean;
}

/**
 * Returns every existing config in Renovate's resolution order, or undefined when one exists but
 * cannot be read or parsed — the caller must then leave the repository untouched, since the
 * unreadable file may be the one currently in effect.
 */
async function readExistingConfigs(config: PackageConfig): Promise<ExistingConfig[] | undefined> {
  const existingConfigs: ExistingConfig[] = [];
  for (const { relativePath, role, isEditableSyntax } of configLocations) {
    const filePath = path.resolve(config.dirPath, relativePath);
    // A shadowed config is never read: wbfy only needs to know it exists in order to bail, and
    // lstat (rather than a read) also counts a dangling symlink, which still names a config
    // location that would resurface once its target is restored.
    if (role === 'shadowed') {
      if (await fs.promises.lstat(filePath).catch(() => {})) {
        existingConfigs.push({ filePath, content: '', settings: {}, role, isEditableSyntax });
      }
      continue;
    }
    // Confined read: a committed symlink pointing outside the repository must not get its
    // target's content copied into the tracked renovate.jsonc.
    const content = await fsUtil.readFileConfinedIfExists(filePath);
    if (content === undefined) {
      // Distinguish "absent" (fine) from "present but refused by the confined read" (fatal).
      if (await fs.promises.lstat(filePath).catch(() => {})) {
        console.warn(`Skipped generating ${managedFileName} because ${filePath} cannot be read safely.`);
        return undefined;
      }
      continue;
    }
    // An empty or comment-only file holds no settings, but it still occupies its slot in the
    // resolution order (an empty renovate.json makes Renovate ignore renovate.jsonc entirely), so
    // it is recorded with empty settings to be deleted like any other superseded config.
    const settings = jsoncUtil.isTriviaOnly(content) ? {} : parseRenovateConfig(isEditableSyntax, content);
    if (!settings) {
      console.warn(`Skipped generating ${managedFileName} because ${filePath} is not parsable.`);
      return undefined;
    }
    existingConfigs.push({ filePath, content, settings, role, isEditableSyntax });
  }
  return existingConfigs;
}

/**
 * JSON5 allows unquoted keys and single-quoted strings, which jsonc-parser rejects outright, so a
 * .json5 config needs the dedicated parser; the other names are JSONC at most.
 */
function parseRenovateConfig(isEditableSyntax: boolean, content: string): Settings | undefined {
  if (isEditableSyntax) return jsoncUtil.parseObjectIgnoringError<Settings>(content);
  try {
    const value: unknown = JSON5.parse(content);
    return !!value && typeof value === 'object' && !Array.isArray(value) ? (value as Settings) : undefined;
  } catch {
    return undefined;
  }
}

function mergeRenovateExtends(generatedExtends: string[], existingExtends: Settings['extends']): string[] {
  // Renovate's schema allows `extends` to be a single preset string; spreading a string would
  // corrupt it into its individual characters, so normalize it to an array first.
  const normalizedExtends =
    existingExtends === undefined ? [] : Array.isArray(existingExtends) ? existingExtends : [existingExtends];
  return [...new Set([...generatedExtends, ...normalizedExtends])].filter((item) => item !== '@willbooster');
}

function normalize(content: string): string {
  const trimmedContent = content.trim();
  return trimmedContent ? trimmedContent + '\n' : '';
}
