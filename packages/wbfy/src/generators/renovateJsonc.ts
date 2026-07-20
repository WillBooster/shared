import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import JSON5 from 'json5';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';
import { sortKeys } from '../utils/objectUtil.js';
import { promisePool } from '../utils/promisePool.js';

const jsonObj = {
  $schema: 'https://docs.renovatebot.com/renovate-schema.json',
  extends: ['github>WillBooster/willbooster-configs:renovate.json5'],
};

type Settings = Omit<typeof jsonObj, 'extends'> & {
  // Renovate's schema allows a single preset string in addition to an array.
  extends?: string | string[];
  packageRules?: { matchPackageNames: string[]; enabled?: boolean }[];
};

// The managed file is renovate.jsonc rather than renovate.json: the settings carry explanatory
// comments (e.g. why a private registry is mapped), and a .jsonc extension states that up front
// instead of leaving a .json file that only Renovate's JSONC-tolerant parser accepts.
const managedFileName = 'renovate.jsonc';

// Renovate stops at the first matching config file, so every alternative is either superseded
// (migrated into renovate.jsonc, then deleted) or shadowing (renovate.jsonc must not be generated
// beside it). Which one it is follows Renovate's documented resolution order:
//   renovate.json > renovate.jsonc > renovate.json5 > .github/* > .gitlab/* > .renovaterc*
//   > package.json "renovate"
// Superseded configs are listed in that order too, so the one Renovate actually reads wins the
// merge below. renovate.json OUTRANKS the managed file, so leaving it behind would silently keep
// the old config live — deleting it is what makes the migration take effect.
const supersededConfigFileNames = ['renovate.json', 'renovate.json5', '.renovaterc.json'];

// Everything Renovate resolves AFTER renovate.jsonc: generating the managed file would shadow
// these, so wbfy bails instead when one exists and renovate.jsonc does not. The list is
// deliberately platform-agnostic: wbfy manages GitHub-hosted repositories, and bailing on a config
// for another platform is a safe no-op rather than a missed generation.
const shadowedRenovateConfigPaths = [
  '.github/renovate.json',
  '.github/renovate.jsonc',
  '.github/renovate.json5',
  '.gitlab/renovate.json',
  '.gitlab/renovate.jsonc',
  '.gitlab/renovate.json5',
  '.renovaterc',
  '.renovaterc.jsonc',
  '.renovaterc.json5',
];

export async function generateRenovateJsonc(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateRenovateJsonc', async () => {
    let newSettings = structuredClone(jsonObj) as Settings;
    const filePath = path.resolve(config.dirPath, managedFileName);
    // A symlinked renovate.jsonc is never managed: writes through it are refused by the
    // confinement guards anyway, and when its target happens to already match the generated
    // settings the semantic no-op below would skip generateFile (and its guard) and proceed to
    // delete the superseded configs — leaving a fresh checkout with only a possibly-dangling
    // external symlink as Renovate configuration.
    const managedFileStats = await fs.promises.lstat(filePath).catch(() => {});
    if (managedFileStats && managedFileStats.isSymbolicLink()) {
      console.warn(`Skipped generating ${filePath} because it is a symbolic link.`);
      return;
    }
    const oldContent = await fsUtil.readFileIfExists(filePath);

    const supersededConfigs = await readSupersededConfigs(config);
    // A superseded config that exists but could not be read safely aborts generation: it may
    // outrank renovate.jsonc (renovate.json does), so writing the bare template could either
    // silently shadow the user's settings or leave a stale config live.
    if (supersededConfigs === undefined) return;

    // The shadow checks matter only while renovate.jsonc does not exist AND nothing is being
    // migrated into it: an existing (or freshly migrated) renovate.jsonc already shadows every
    // alternative below it in the resolution order and must stay managed.
    if (
      oldContent === undefined &&
      supersededConfigs.length === 0 &&
      (shadowedRenovateConfigPaths.some(
        // lstat instead of existsSync: a dangling symlink still names an alternative config
        // location that would resurface (and be shadowed) once its target is restored.
        (configPath) => !!fs.lstatSync(path.resolve(config.dirPath, configPath), { throwIfNoEntry: false })
      ) ||
        config.packageJson?.['renovate'])
    ) {
      return;
    }

    // Renovate accepts JSONC in renovate.jsonc; an existing file wbfy cannot parse must be left
    // untouched instead of being overwritten with the bare template.
    let oldSettings: Settings | undefined;
    let originalSettingsJson: string | undefined;
    if (oldContent !== undefined && !jsoncUtil.isTriviaOnly(oldContent)) {
      oldSettings = jsoncUtil.parseObjectIgnoringError<Settings>(oldContent);
      if (!oldSettings) {
        console.warn(`Skipped generating ${filePath} because the existing content is not parsable.`);
        return;
      }
      originalSettingsJson = JSON.stringify(sortKeys(structuredClone(oldSettings) as Record<string, unknown>));
    }

    // Merge the superseded configs from the lowest-priority one up, so the config Renovate
    // currently reads overwrites the dead ones on conflict.
    for (const superseded of [...supersededConfigs].toReversed()) {
      oldSettings = oldSettings
        ? (merge(oldSettings, superseded.settings, { arrayMerge: overwriteMerge }) as Settings)
        : superseded.settings;
    }

    if (oldSettings) {
      newSettings = merge.all([newSettings, oldSettings, newSettings], {
        arrayMerge: overwriteMerge,
      }) as Settings;
    }
    newSettings.extends = mergeRenovateExtends(jsonObj.extends, oldSettings?.extends);

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

    // Skip the write when nothing changes semantically, so comments and formatting in an
    // already-clean renovate.jsonc survive wbfy runs.
    if (originalSettingsJson !== JSON.stringify(sortKeys(structuredClone(newSettings) as Record<string, unknown>))) {
      const newContent = jsoncUtil.stringifyPreservingTrivia(oldContent, newSettings as Record<string, unknown>);
      // Await the write directly: the superseded sources below must survive when the confinement
      // guards refuse the write (e.g. renovate.jsonc is a dangling symlink).
      if (!(await fsUtil.generateFile(filePath, newContent))) return;
    }

    // JSON5 (and plain JSON) sources are re-serialized rather than edited in place, so their
    // comments cannot be carried over automatically. Name them so they can be restored by hand.
    for (const superseded of supersededConfigs) {
      if (jsoncUtil.containsComment(superseded.content)) {
        console.warn(
          `Comments in ${superseded.filePath} were dropped while migrating it into ${filePath}; copy them over manually.`
        );
      }
    }

    await promisePool.run(() =>
      fsUtil.removeConfined(path.resolve(config.dirPath, '.dependabot'), { recursive: true })
    );
    // Remove the superseded configs once their settings were migrated above (for a symlink this
    // deletes only the link entry). Deleting renovate.json is what activates the migration: it
    // outranks renovate.jsonc, so keeping it would leave the pre-migration config live.
    for (const superseded of supersededConfigs) {
      await promisePool.run(() => fsUtil.removeConfined(superseded.filePath));
    }
  });
}

interface SupersededConfig {
  filePath: string;
  content: string;
  settings: Settings;
}

/**
 * Reads every superseded config in Renovate's resolution order, or returns undefined when one
 * exists but cannot be read or parsed — the caller must then leave the repository untouched.
 */
async function readSupersededConfigs(config: PackageConfig): Promise<SupersededConfig[] | undefined> {
  const supersededConfigs: SupersededConfig[] = [];
  for (const fileName of supersededConfigFileNames) {
    const filePath = path.resolve(config.dirPath, fileName);
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
    if (jsoncUtil.isTriviaOnly(content)) continue;
    const settings = parseRenovateConfig(fileName, content);
    if (!settings) {
      console.warn(`Skipped generating ${managedFileName} because ${filePath} is not parsable.`);
      return undefined;
    }
    supersededConfigs.push({ filePath, content, settings });
  }
  return supersededConfigs;
}

/**
 * JSON5 allows unquoted keys and single-quoted strings, which jsonc-parser rejects outright, so
 * renovate.json5 needs the dedicated parser; the other superseded names are JSONC at most.
 */
function parseRenovateConfig(fileName: string, content: string): Settings | undefined {
  if (!fileName.endsWith('.json5')) return jsoncUtil.parseObjectIgnoringError<Settings>(content);
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
