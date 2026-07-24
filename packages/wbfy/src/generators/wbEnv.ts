import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'smol-toml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';

interface FnoxTomlSubtree {
  secrets?: Record<string, unknown>;
  profiles?: Record<string, { secrets?: Record<string, unknown> } | undefined>;
}

// The four standard WB_ENV modes; staging is optional and only completed when the repository
// already declares the staging profile.
const wbEnvModes = ['development', 'test', 'staging', 'production'] as const;
type WbEnvMode = (typeof wbEnvModes)[number];

/**
 * Ensures a fnox repository defines WB_ENV for every standard mode (and NEXT_PUBLIC_WB_ENV when
 * any workspace depends on Next.js or vinext) in fnox.toml profiles. Existing definitions are
 * always left untouched. Non-fnox repositories are skipped: .env files are no longer managed.
 */
export async function ensureWbEnvDefinitions(rootConfig: PackageConfig, allConfigs: PackageConfig[]): Promise<void> {
  return logger.functionIgnoringException('ensureWbEnvDefinitions', async () => {
    const needsNextPublic = allConfigs.some((config) => requiresNextPublicWbEnv(config));
    const fnoxTomlPath = path.resolve(rootConfig.dirPath, 'fnox.toml');
    // lstat, not existsSync: existsSync is false for a DANGLING fnox.toml symlink; any fnox.toml
    // directory entry marks a fnox repository, and a refused/dangling one aborts instead of
    // being treated as a non-fnox repository while the fnox synchronization is failing.
    if (!(await fs.promises.lstat(fnoxTomlPath).catch(() => {}))) return;
    const content = await fsUtil.readFileConfinedIfExists(fnoxTomlPath);
    if (content === undefined) return;
    const updatedContent = insertWbEnvIntoFnoxToml(content, needsNextPublic);
    if (updatedContent !== undefined && updatedContent !== content) {
      await fsUtil.generateFile(fnoxTomlPath, updatedContent);
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
    '# CI sets WB_ENV as a process env var, which wins over fnox when loaded through wb; bare fnox run/export uses the fnox value, so pass -P <profile>.';
  // Earlier wbfy versions wrote a comment overstating the precedence (bare `fnox run/export` lets
  // the fnox value win over an inherited process env var), in several wording variants (with or
  // without a trailing period); rewrite any of them in place so target repositories converge on
  // the corrected wording instead of keeping the stale claim forever.
  const outdatedWbEnvCommentPattern =
    /^# CI sets WB_ENV as a process env var, which wins over fnox;(?! when loaded through wb).*$/mu;
  const obsoleteRequiredKeysCommentPattern =
    /^# \(wb's required-keys check treats every \.env\.example key, including WB_ENV, as required\)\.\n?/mu;
  const keyNames = needsNextPublic ? ['WB_ENV', 'NEXT_PUBLIC_WB_ENV'] : ['WB_ENV'];
  let updatedContent = content
    .replace(outdatedWbEnvCommentPattern, wbEnvComment)
    .replace(obsoleteRequiredKeysCommentPattern, '');
  for (const mode of wbEnvModes) {
    // The staging mode is optional: complete it only when the repository already declares the profile.
    if (mode === 'staging' && !settings.profiles?.staging) continue;
    const definedKeys = mode === 'development' ? settings.secrets : settings.profiles?.[mode]?.secrets;
    for (const keyName of keyNames) {
      const defined = definedKeys?.[keyName];
      const definedValue =
        typeof defined === 'string' ? defined : (defined as { default?: unknown } | undefined)?.default;
      warnOnUnexpectedWbEnvValue(keyName, definedValue, mode);
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
 * possible signal. The passed value is always plaintext (a fnox `default` field) — encrypted
 * fnox entries are `{ provider, value }` objects whose `default` is absent.
 */
function warnOnUnexpectedWbEnvValue(keyName: string, value: unknown, mode: WbEnvMode): void {
  // An EMPTY value counts as unset (wb supplies the fallback mode), not as a mismatching mode.
  if (typeof value !== 'string' || value === '' || value === mode) return;
  // A dynamic value (e.g. `NEXT_PUBLIC_WB_ENV=${WB_ENV}`) may legitimately resolve to the mode
  // through expansion, which this static check cannot evaluate — skip instead of misfiring.
  // fnox expands only `${...}` (a bare `$UNSET` stays literal).
  if (value.includes('${')) return;
  if (keyName === 'NEXT_PUBLIC_WB_ENV') {
    console.warn(
      `${keyName} in fnox.toml is "${value}" but should be "${mode}" for the ${mode} mode; wb overrides it with WB_ENV, but a direct framework build would inline this value.`
    );
    return;
  }
  console.warn(
    `${keyName} in fnox.toml is "${value}" but should be "${mode}" for the ${mode} mode; wb rejects values outside development/test/staging/production.`
  );
}

/**
 * Inserts lines at the top of a TOML section, right after its `[header]` line so profile-specific
 * entries stay grouped with their header; the section is appended at the end when it is absent.
 */
function insertIntoFnoxSection(content: string, sectionName: string, insertedLines: string[]): string {
  // wbfy writes the header without whitespace around the dotted-key components.
  const headerPattern = new RegExp(String.raw`^\s*\[${sectionName.replaceAll('.', String.raw`\.`)}\]\s*(?:#.*)?$`, 'u');
  const lines = content.split('\n');
  const headerIndex = lines.findIndex((line) => headerPattern.test(line));
  if (headerIndex === -1) {
    return `${content.trimEnd()}\n\n[${sectionName}]\n${insertedLines.join('\n')}\n`;
  }
  return [...lines.slice(0, headerIndex + 1), ...insertedLines, ...lines.slice(headerIndex + 1)].join('\n');
}
