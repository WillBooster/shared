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

const sharedPreset = 'github>WillBooster/willbooster-configs:renovate.jsonc';

const jsonObj = {
  $schema: 'https://docs.renovatebot.com/renovate-schema.json',
  extends: [sharedPreset],
};

// The preset used to live in renovate.json5; it was renamed to renovate.jsonc, so the old reference
// now fails to resolve ("Cannot find preset's package"). Drop it while migrating, like @willbooster.
const legacyPresets = new Set(['@willbooster', 'github>WillBooster/willbooster-configs:renovate.json5']);

// $schema is optional: an existing config need not declare it.
type Settings = Partial<typeof jsonObj> & {
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
//   bails instead.
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
  { relativePath: '.renovaterc.json', role: 'superseded', isEditableSyntax: true },
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

    // Renovate reads only the highest-priority config, so it alone carries the live settings.
    // A shadowed one winning means renovate.jsonc would outrank (and silently replace) the config
    // currently in effect — including a `renovate` section in package.json, which every file
    // outranks and which wbfy cannot migrate.
    const liveConfig = existingConfigs[0];
    if (liveConfig?.role === 'shadowed') return;
    if (!liveConfig && config.packageJson?.['renovate']) return;

    // Only the live config must be understood: the lower-priority ones are dead config that this
    // run overwrites or deletes, so a malformed leftover must not block the migration.
    let liveSettings: Settings | undefined;
    if (liveConfig) {
      if (liveConfig.content === undefined) {
        console.warn(`Skipped generating ${filePath} because ${liveConfig.filePath} cannot be read safely.`);
        return;
      }
      liveSettings = jsoncUtil.isTriviaOnly(liveConfig.content)
        ? {}
        : parseRenovateConfig(liveConfig.isEditableSyntax, liveConfig.content);
      if (!liveSettings) {
        console.warn(`Skipped generating ${filePath} because ${liveConfig.filePath} is not parsable.`);
        return;
      }
    }

    const oldContent = existingConfigs.find((existing) => existing.role === 'managed')?.content;
    // Edit the live config in place so its comments and formatting survive. A JSON5 source cannot
    // be edited (jsonc-parser rejects unquoted keys and single-quoted strings) and is re-serialized
    // instead, which the warning below reports.
    const baseContent = liveConfig?.isEditableSyntax ? liveConfig.content : undefined;

    const newSettings = buildSettings(config, liveSettings);
    const { content: newContent, keysLosingComments } = jsoncUtil.stringifyPreservingTrivia(
      baseContent,
      newSettings as Record<string, unknown>
    );
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

    // Only report losses once the managed file actually holds the new content — a refused write
    // leaves every source untouched, and warning there would claim a data loss that never happened.
    // Editing in place preserves comments property by property, but a property whose value had to
    // be rewritten wholesale (e.g. `extends` losing the legacy @willbooster preset) takes its
    // nested comments with it.
    for (const key of keysLosingComments) {
      console.warn(`Comments inside "${key}" were dropped while rewriting it in ${filePath}.`);
    }

    // Every config other than the live one loses its comments here — the superseded ones by being
    // deleted below, and a non-live managed file by being overwritten with the live settings.
    for (const discarded of existingConfigs) {
      if (discarded.role === 'shadowed' || discarded.content === undefined) continue;
      if (!jsoncUtil.containsComment(discarded.content)) continue;
      // The live source's comments came along whenever it doubled as the editing base, so only a
      // re-serialized (JSON5) one loses them. A dead config's comments describe settings that were
      // never in effect, so telling the user to copy those would be actively misleading.
      if (discarded === liveConfig) {
        if (discarded.content === baseContent) continue;
        console.warn(
          `Comments in ${discarded.filePath} were dropped while migrating it into ${filePath}; copy them over manually.`
        );
        continue;
      }
      const fate = discarded.role === 'managed' ? 'overwritten' : 'deleted';
      console.warn(
        `${discarded.filePath} was ${fate} with its comments: ${liveConfig?.filePath} took precedence, so Renovate never read it.`
      );
    }
    await promisePool.run(() =>
      fsUtil.removeConfined(path.resolve(config.dirPath, '.dependabot'), { recursive: true })
    );
    // Remove the superseded configs once the managed file is in place (for a symlink this deletes
    // only the link entry). Even a dead one must go: it would otherwise keep occupying its slot in
    // the resolution order, and an empty renovate.json is enough to hide renovate.jsonc entirely.
    for (const superseded of existingConfigs.filter((existing) => existing.role === 'superseded')) {
      await promisePool.run(() => fsUtil.removeConfined(superseded.filePath));
    }
  });
}

/** Merges the generated settings on top of the live ones, leaving the live values in place. */
function buildSettings(config: PackageConfig, liveSettings: Settings | undefined): Settings {
  const generatedSettings = structuredClone(jsonObj) as Settings;
  // willbooster-configs' renovate.jsonc IS the shared preset, so extending it there is a
  // self-reference: it says nothing, and Renovate is one recursion-guard change away from failing
  // to resolve the preset for every repository in both orgs.
  const generatedExtends = config.isWillBoosterConfigs ? [] : jsonObj.extends;
  const newSettings = liveSettings
    ? (merge.all([generatedSettings, liveSettings, generatedSettings], {
        arrayMerge: overwriteMerge,
      }) as Settings)
    : generatedSettings;
  newSettings.extends = mergeRenovateExtends(generatedExtends, liveSettings?.extends).filter(
    (preset) => !config.isWillBoosterConfigs || preset.toLowerCase() !== sharedPreset.toLowerCase()
  );
  return newSettings;
}

interface ExistingConfig {
  filePath: string;
  /** undefined when the file exists but the confined read refused it (e.g. an outside symlink). */
  content: string | undefined;
  role: (typeof configLocations)[number]['role'];
  isEditableSyntax: boolean;
}

/**
 * Returns every existing config in Renovate's resolution order, without parsing any of them: only
 * the live one (the first entry) has to be understood, and a malformed lower-priority leftover
 * must not block the migration.
 */
async function readExistingConfigs(config: PackageConfig): Promise<ExistingConfig[]> {
  const existingConfigs: ExistingConfig[] = [];
  for (const { relativePath, role, isEditableSyntax } of configLocations) {
    const filePath = path.resolve(config.dirPath, relativePath);
    // A shadowed config is never read: wbfy only needs to know it exists in order to bail, and
    // lstat (rather than a read) also counts a dangling symlink, which still names a config
    // location that would resurface once its target is restored.
    if (role === 'shadowed') {
      if (await fs.promises.lstat(filePath).catch(() => {})) {
        existingConfigs.push({ filePath, content: undefined, role, isEditableSyntax });
      }
      continue;
    }
    const content = await readContentIfPossible(filePath);
    // Distinguish "absent" (skip it) from "present but refused by the confined read", which still
    // occupies its slot in the resolution order and must be recorded.
    if (content === undefined && !(await fs.promises.lstat(filePath).catch(() => {}))) continue;
    existingConfigs.push({ filePath, content, role, isEditableSyntax });
  }
  return existingConfigs;
}

/**
 * Confined read: a committed symlink pointing outside the repository must not get its target's
 * content copied into the tracked renovate.jsonc. A read that fails outright (e.g. EACCES) yields
 * undefined rather than throwing — only the live config's content is required, and a dead file's
 * content is used solely for the comment-loss warning, so one unreadable leftover must not abort
 * the whole generator. The caller still bails when the unreadable file is the live one.
 */
async function readContentIfPossible(filePath: string): Promise<string | undefined> {
  try {
    return await fsUtil.readFileConfinedIfExists(filePath);
  } catch {
    return;
  }
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

function mergeRenovateExtends(generatedExtends: string[], existingExtends: string[] = []): string[] {
  // Only prepend the presets that are missing. Moving one that is already listed would reorder the
  // array, and a later preset overrides an earlier one in Renovate — so re-sorting silently flips
  // which config wins (and, being a reorder rather than an addition, also costs the array's
  // comments, which can only be preserved by insertion).
  const missingExtends = generatedExtends.filter((preset) => !existingExtends.includes(preset));
  return [...missingExtends, ...existingExtends].filter((item) => !legacyPresets.has(item));
}

function normalize(content: string): string {
  const trimmedContent = content.trim();
  return trimmedContent ? trimmedContent + '\n' : '';
}
