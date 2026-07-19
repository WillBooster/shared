import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';
import { parse } from 'smol-toml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';

interface FnoxTomlSubtree {
  secrets?: Record<string, unknown>;
  profiles?: Record<string, { secrets?: Record<string, unknown> } | undefined>;
}

// The four standard WB_ENV modes; staging is optional and only completed when the repository
// already declares it (a staging profile / .env.staging file).
const wbEnvModes = ['development', 'test', 'staging', 'production'] as const;
type WbEnvMode = (typeof wbEnvModes)[number];

/**
 * Ensures the repository defines WB_ENV for every standard mode (and NEXT_PUBLIC_WB_ENV when any
 * workspace depends on Next.js or vinext): in fnox.toml profiles for fnox-based repositories, and
 * in the legacy .env mode files otherwise. Existing definitions are always left untouched.
 */
export async function ensureWbEnvDefinitions(rootConfig: PackageConfig, allConfigs: PackageConfig[]): Promise<void> {
  return logger.functionIgnoringException('ensureWbEnvDefinitions', async () => {
    const needsNextPublic = allConfigs.some((config) => requiresNextPublicWbEnv(config));
    const fnoxTomlPath = path.resolve(rootConfig.dirPath, 'fnox.toml');
    // lstat, not existsSync: existsSync is false for a DANGLING fnox.toml symlink, which would
    // wrongly select the legacy .env branch and mutate the wrong configuration family while the
    // fnox synchronization is failing. Any fnox.toml directory entry marks a fnox repository;
    // a refused/dangling one aborts instead of falling back.
    if (await fs.promises.lstat(fnoxTomlPath).catch(() => {})) {
      const content = await fsUtil.readFileConfinedIfExists(fnoxTomlPath);
      if (content === undefined) return;
      const updatedContent = insertWbEnvIntoFnoxToml(content, needsNextPublic);
      if (updatedContent !== undefined && updatedContent !== content) {
        await fsUtil.generateFile(fnoxTomlPath, updatedContent);
      }
      return;
    }
    // Complete the mode files of every workspace, not just the root: Next.js and Vite load .env*
    // relative to the application's own project directory, so a root-only insertion would leave
    // e.g. apps/web/.env without WB_ENV. NEXT_PUBLIC_WB_ENV follows each workspace's own
    // framework dependency (the root keeps the repository-wide signal for shared tooling).
    for (const config of allConfigs) {
      const needsNextPublicHere = config === rootConfig ? needsNextPublic : requiresNextPublicWbEnv(config);
      // `.env.local` outranks every canonical `.env.<mode>` file in EVERY cascade, so a static
      // WB_ENV-family definition there breaks each non-matching mode (wb fails fast on the
      // mismatch); warn regardless of the value.
      const localContent = await fsUtil.readFileConfinedIfExists(path.resolve(config.dirPath, '.env.local'));
      if (localContent !== undefined) {
        const localKeys = dotenv.parse(localContent);
        for (const keyName of ['WB_ENV', 'NEXT_PUBLIC_WB_ENV']) {
          const value = localKeys[keyName];
          if (typeof value === 'string' && !value.includes('$')) {
            console.warn(
              `${keyName} in .env.local is "${value}", which overrides every cascade mode; remove it (wb fails fast when it mismatches the selected mode).`
            );
          }
        }
      }
      for (const mode of wbEnvModes) {
        // Warn-only inspection of the HIGHER-precedence cascade variants the loader also reads
        // (`.env.development` for the development cascade, `.env.<mode>.local` for every mode):
        // a mismatched WB_ENV there overrides the canonical file's correct value, so checking
        // the canonical file alone could even report a broken repository as correct.
        const keyNames = needsNextPublicHere ? ['WB_ENV', 'NEXT_PUBLIC_WB_ENV'] : ['WB_ENV'];
        const variantFileNames =
          mode === 'development' ? ['.env.development', '.env.development.local'] : [`.env.${mode}.local`];
        for (const variantFileName of variantFileNames) {
          const variantContent = await fsUtil.readFileConfinedIfExists(path.resolve(config.dirPath, variantFileName));
          if (variantContent === undefined) continue;
          const definedVariantKeys = dotenv.parse(variantContent);
          for (const keyName of keyNames) {
            warnOnUnexpectedWbEnvValue(keyName, definedVariantKeys[keyName], mode, variantFileName);
          }
        }
        const envFilePath = path.resolve(config.dirPath, mode === 'development' ? '.env' : `.env.${mode}`);
        const envContent = await fsUtil.readFileConfinedIfExists(envFilePath);
        // Only existing mode files are completed: creating .env.production (never committed by
        // convention) or a whole legacy layout from nothing is not wbfy's call.
        if (envContent === undefined) continue;
        const updatedEnvContent = insertWbEnvIntoEnvFile(envContent, mode, needsNextPublicHere);
        // Log only when the confined write actually happened; writeFileConfined refuses symlinks
        // and paths resolving outside the repository (with its own warning).
        if (updatedEnvContent !== envContent && (await fsUtil.writeFileConfined(envFilePath, updatedEnvContent))) {
          console.log(`Generated/Updated ${envFilePath}`);
        }
      }
    }
  });
}

/**
 * Mirrors wb's requiresNextPublicWbEnv contract (packages/wb/src/project.ts): the framework may
 * be declared in ANY of the four dependency sections (e.g. `next` as a devDependency in a shared
 * component library), while wbfy's `depending.next` looks only at regular dependencies.
 */
function requiresNextPublicWbEnv(config: PackageConfig): boolean {
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((section) => {
    const dependencies = config.packageJson?.[section as 'dependencies'];
    return !!dependencies?.['next'] || !!dependencies?.['vinext'];
  });
}

/**
 * Inserts missing WB_ENV (and optionally NEXT_PUBLIC_WB_ENV) entries into a fnox.toml: the base
 * `[secrets]` table carries the development defaults and `[profiles.<mode>.secrets]` overlays
 * each other mode, matching the org-standard layout. Formatting and comments are preserved (only
 * missing lines are inserted / missing sections appended). Returns undefined when the content
 * cannot be safely edited (unparsable before or after the edit).
 */
export function insertWbEnvIntoFnoxToml(content: string, needsNextPublic: boolean): string | undefined {
  let settings: FnoxTomlSubtree;
  try {
    settings = parse(content) as FnoxTomlSubtree;
  } catch {
    console.warn('Skipped inserting WB_ENV into fnox.toml because it is not parsable as TOML.');
    return undefined;
  }

  const wbEnvComment =
    '# CI sets WB_ENV as a process env var, which wins over fnox; these defaults only fill it locally.';
  const keyNames = needsNextPublic ? ['WB_ENV', 'NEXT_PUBLIC_WB_ENV'] : ['WB_ENV'];
  let updatedContent = content;
  for (const mode of wbEnvModes) {
    // The staging mode is optional: complete it only when the repository already declares the profile.
    if (mode === 'staging' && !settings.profiles?.staging) continue;
    const definedKeys = mode === 'development' ? settings.secrets : settings.profiles?.[mode]?.secrets;
    for (const keyName of keyNames) {
      const defined = definedKeys?.[keyName];
      const definedValue =
        typeof defined === 'string' ? defined : (defined as { default?: unknown } | undefined)?.default;
      warnOnUnexpectedWbEnvValue(keyName, definedValue, mode, 'fnox.toml');
    }
    const missingLines = keyNames
      .filter((keyName) => definedKeys?.[keyName] === undefined)
      .map((keyName) => `${keyName} = { default = "${mode}" }`);
    if (missingLines.length === 0) continue;
    // Skip the comment when a previous run already wrote it (e.g. WB_ENV exists and only
    // NEXT_PUBLIC_WB_ENV is inserted now); re-inserting would duplicate it on every such run.
    const includesComment = mode === 'development' && !updatedContent.includes(wbEnvComment);
    updatedContent = insertIntoFnoxSection(
      updatedContent,
      mode === 'development' ? 'secrets' : `profiles.${mode}.secrets`,
      includesComment ? [wbEnvComment, ...missingLines] : missingLines
    );
  }
  if (updatedContent === content) return content;

  // Re-parse before returning: an unusual layout (e.g. dotted keys without a table header) could
  // make the textual edit produce a duplicate table; fail safely instead of corrupting the file.
  try {
    const updatedSettings = parse(updatedContent) as FnoxTomlSubtree;
    for (const mode of wbEnvModes) {
      if (mode === 'staging' && !settings.profiles?.staging) continue;
      const definedKeys = mode === 'development' ? updatedSettings.secrets : updatedSettings.profiles?.[mode]?.secrets;
      if (keyNames.some((keyName) => definedKeys?.[keyName] === undefined)) {
        throw new Error(`the inserted ${mode} entries did not take effect`);
      }
    }
  } catch (error) {
    console.warn(`Skipped inserting WB_ENV into fnox.toml because ${(error as Error).message}.`);
    return undefined;
  }
  return updatedContent;
}

/**
 * Warns when an existing WB_ENV-family definition names a different mode than the one it is
 * defined for (a typo like `prodcution` or `production1`, or a copy-pasted wrong mode): wb
 * rejects non-standard values at runtime, so surfacing the mismatch during wbfy is the earliest
 * possible signal. The passed value is always plaintext (a dotenv value or a fnox `default`
 * field) — encrypted fnox entries are `{ provider, value }` objects whose `default` is absent.
 */
function warnOnUnexpectedWbEnvValue(keyName: string, value: unknown, mode: WbEnvMode, sourceLabel: string): void {
  if (typeof value !== 'string' || value === mode) return;
  // A dynamic value (e.g. `WB_ENV=${MODE}`) may legitimately resolve to the mode through wb's
  // dotenv expansion, which this static check cannot evaluate — skip instead of misfiring.
  if (value.includes('$')) return;
  console.warn(
    `${keyName} in ${sourceLabel} is "${value}" but should be "${mode}" for the ${mode} mode; wb rejects values outside development/test/staging/production.`
  );
}

/**
 * Inserts lines at the top of a TOML section, right after its `[header]` line so profile-specific
 * entries stay grouped with their header; the section is appended at the end when it is absent.
 */
function insertIntoFnoxSection(content: string, sectionName: string, insertedLines: string[]): string {
  const headerPattern = new RegExp(
    String.raw`^\s*\[\s*${sectionName.split('.').join(String.raw`\s*\.\s*`)}\s*\]\s*(?:#.*)?$`,
    'u'
  );
  const lines = content.split('\n');
  const headerIndex = lines.findIndex((line) => headerPattern.test(line));
  if (headerIndex === -1) {
    return `${content.trimEnd()}\n\n[${sectionName}]\n${insertedLines.join('\n')}\n`;
  }
  return [...lines.slice(0, headerIndex + 1), ...insertedLines, ...lines.slice(headerIndex + 1)].join('\n');
}

/**
 * Appends a missing WB_ENV (and optionally NEXT_PUBLIC_WB_ENV) assignment to a legacy .env mode
 * file, leaving existing assignments (including `export`-prefixed ones) untouched.
 */
export function insertWbEnvIntoEnvFile(content: string, mode: WbEnvMode, needsNextPublic: boolean): string {
  const keyNames = needsNextPublic ? ['WB_ENV', 'NEXT_PUBLIC_WB_ENV'] : ['WB_ENV'];
  // Detect existing keys with dotenv's parser, not a per-line regex: a quoted multiline value may
  // contain a `WB_ENV=...` LINE without defining the key, which a raw line match would treat as an
  // existing definition and skip the insertion.
  const definedKeys = dotenv.parse(content);
  for (const keyName of keyNames) {
    warnOnUnexpectedWbEnvValue(keyName, definedKeys[keyName], mode, mode === 'development' ? '.env' : `.env.${mode}`);
  }
  const missingLines = keyNames
    .filter((keyName) => definedKeys[keyName] === undefined)
    .map((keyName) => `${keyName}=${mode}`);
  if (missingLines.length === 0) return content;
  const body = content.trimEnd();
  return `${body ? `${body}\n` : ''}${missingLines.join('\n')}\n`;
}
