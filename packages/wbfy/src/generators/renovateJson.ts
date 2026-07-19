import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';

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

// Renovate stops at the first matching config file and renovate.json matches first, so generating
// renovate.json next to any of these alternative locations would silently shadow the user's
// config. `.renovaterc.json` is intentionally absent: wbfy migrates it into renovate.json below.
// The list is deliberately platform-agnostic: wbfy manages GitHub-hosted repositories, and bailing
// on a config for another platform is a safe no-op rather than a missed generation.
const shadowedRenovateConfigPaths = [
  'renovate.jsonc',
  'renovate.json5',
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

export async function generateRenovateJson(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateRenovateJson', async () => {
    let newSettings = structuredClone(jsonObj) as Settings;
    const filePath = path.resolve(config.dirPath, 'renovate.json');
    // A symlinked renovate.json is never managed: writes through it are refused by the
    // confinement guards anyway, and when its target happens to already match the generated
    // settings the semantic no-op below would skip generateFile (and its guard) and proceed to
    // delete the in-repository fallbacks (.dependabot, .renovaterc.json) — leaving a fresh
    // checkout with only a possibly-dangling external symlink as Renovate configuration.
    const managedFileStats = await fs.promises.lstat(filePath).catch(() => {});
    if (managedFileStats && managedFileStats.isSymbolicLink()) {
      console.warn(`Skipped generating ${filePath} because it is a symbolic link.`);
      return;
    }
    const oldContent = await fsUtil.readFileIfExists(filePath);
    // The shadow checks matter only while renovate.json does not exist: it is FIRST in Renovate's
    // resolution order, so an existing renovate.json already shadows every alternative (including
    // a "renovate" section in package.json, the LAST entry) and must stay managed.
    if (
      oldContent === undefined &&
      // lstat instead of existsSync: a dangling symlink still names an alternative config location
      // that would resurface (and be shadowed) once its target is restored.
      (shadowedRenovateConfigPaths.some(
        (configPath) => !!fs.lstatSync(path.resolve(config.dirPath, configPath), { throwIfNoEntry: false })
      ) ||
        config.packageJson?.['renovate'])
    ) {
      return;
    }

    // Renovate accepts JSONC in renovate.json; an existing file wbfy cannot parse must be left
    // untouched instead of being overwritten with the bare template.
    let oldSettings: Settings | undefined;
    let originalSettingsJson: string | undefined;
    if (oldContent !== undefined && !jsoncUtil.isTriviaOnly(oldContent)) {
      oldSettings = jsoncUtil.parseObjectIgnoringError<Settings>(oldContent);
      if (!oldSettings) {
        console.warn(`Skipped generating ${filePath} because the existing content is not parsable as JSONC.`);
        return;
      }
      originalSettingsJson = JSON.stringify(sortKeys(structuredClone(oldSettings) as Record<string, unknown>));
    }

    // A legacy .renovaterc.json is migrated into the generated renovate.json before it is deleted
    // below — but only when renovate.json does not exist yet: renovate.json resolves first, so a
    // .renovaterc.json next to it is dead config whose settings must not be resurrected.
    const legacyFilePath = path.resolve(config.dirPath, '.renovaterc.json');
    // Confined read: a committed .renovaterc.json symlink pointing outside the repository must not
    // get its target's content copied into the tracked renovate.json.
    const legacyContent = oldContent === undefined ? await fsUtil.readFileConfinedIfExists(legacyFilePath) : undefined;
    // A legacy config that exists but was refused by the confined read (a symlink or a path
    // resolving outside the repository) must abort generation: renovate.json resolves before
    // .renovaterc.json, so generating the bare template would silently shadow the user's settings.
    if (
      oldContent === undefined &&
      legacyContent === undefined &&
      (await fs.promises.lstat(legacyFilePath).catch(() => {}))
    ) {
      console.warn(`Skipped generating ${filePath} because ${legacyFilePath} exists but cannot be read safely.`);
      return;
    }
    if (legacyContent !== undefined && !jsoncUtil.isTriviaOnly(legacyContent)) {
      oldSettings = jsoncUtil.parseObjectIgnoringError<Settings>(legacyContent);
      if (!oldSettings) {
        console.warn(`Skipped generating ${filePath} because ${legacyFilePath} is not parsable as JSONC.`);
        return;
      }
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

    // Skip the write when nothing changes semantically, so JSONC comments and formatting in an
    // already-clean renovate.json survive wbfy runs.
    if (originalSettingsJson !== JSON.stringify(sortKeys(structuredClone(newSettings) as Record<string, unknown>))) {
      const newContent = JSON.stringify(newSettings, undefined, 2);
      // Await the write directly: the superseded sources below must survive when the confinement
      // guards refuse the write (e.g. renovate.json is a dangling symlink).
      if (!(await fsUtil.generateFile(filePath, newContent))) return;
    }
    await promisePool.run(() =>
      fsUtil.removeConfined(path.resolve(config.dirPath, '.dependabot'), { recursive: true })
    );
    // Remove the legacy config once its settings were migrated above (for a symlink this deletes
    // only the link entry). An unread symlinked legacy next to a pre-existing renovate.json is
    // kept: its settings were never migrated, so deleting the link would silently drop them.
    const legacyStats = await fs.promises.lstat(legacyFilePath).catch(() => {});
    if (legacyStats && (legacyContent !== undefined || !legacyStats.isSymbolicLink())) {
      await promisePool.run(() => fsUtil.removeConfined(legacyFilePath));
    }
  });
}

function mergeRenovateExtends(generatedExtends: string[], existingExtends: Settings['extends']): string[] {
  // Renovate's schema allows `extends` to be a single preset string; spreading a string would
  // corrupt it into its individual characters, so normalize it to an array first.
  const normalizedExtends =
    existingExtends === undefined ? [] : Array.isArray(existingExtends) ? existingExtends : [existingExtends];
  return [...new Set([...generatedExtends, ...normalizedExtends])].filter((item) => item !== '@willbooster');
}
