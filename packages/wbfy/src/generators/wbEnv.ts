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
    const needsNextPublic = allConfigs.some((config) => config.depending.next || config.depending.vinext);
    const fnoxTomlPath = path.resolve(rootConfig.dirPath, 'fnox.toml');
    if (fs.existsSync(fnoxTomlPath)) {
      const content = await fsUtil.readFileConfinedIfExists(fnoxTomlPath);
      if (content === undefined) return;
      const updatedContent = insertWbEnvIntoFnoxToml(content, needsNextPublic);
      if (updatedContent !== undefined && updatedContent !== content) {
        await fsUtil.generateFile(fnoxTomlPath, updatedContent);
      }
      return;
    }
    for (const mode of wbEnvModes) {
      const envFilePath = path.resolve(rootConfig.dirPath, mode === 'development' ? '.env' : `.env.${mode}`);
      const envContent = await fsUtil.readFileConfinedIfExists(envFilePath);
      // Only existing mode files are completed: creating .env.production (never committed by
      // convention) or a whole legacy layout from nothing is not wbfy's call.
      if (envContent === undefined) continue;
      const updatedEnvContent = insertWbEnvIntoEnvFile(envContent, mode, needsNextPublic);
      if (updatedEnvContent !== envContent) {
        await fsUtil.writeFileConfined(envFilePath, updatedEnvContent);
        console.log(`Generated/Updated ${envFilePath}`);
      }
    }
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

  const keyNames = needsNextPublic ? ['WB_ENV', 'NEXT_PUBLIC_WB_ENV'] : ['WB_ENV'];
  let updatedContent = content;
  for (const mode of wbEnvModes) {
    // The staging mode is optional: complete it only when the repository already declares the profile.
    if (mode === 'staging' && !settings.profiles?.staging) continue;
    const definedKeys = mode === 'development' ? settings.secrets : settings.profiles?.[mode]?.secrets;
    const missingLines = keyNames
      .filter((keyName) => definedKeys?.[keyName] === undefined)
      .map((keyName) => `${keyName} = { default = "${mode}" }`);
    if (missingLines.length === 0) continue;
    updatedContent = insertIntoFnoxSection(
      updatedContent,
      mode === 'development' ? 'secrets' : `profiles.${mode}.secrets`,
      mode === 'development'
        ? [
            '# CI sets WB_ENV as a process env var, which wins over fnox; these defaults only fill it locally.',
            ...missingLines,
          ]
        : missingLines
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
  const missingLines = keyNames
    .filter((keyName) => !new RegExp(String.raw`^\s*(?:export\s+)?${keyName}\s*=`, 'mu').test(content))
    .map((keyName) => `${keyName}=${mode}`);
  if (missingLines.length === 0) return content;
  const body = content.trimEnd();
  return `${body ? `${body}\n` : ''}${missingLines.join('\n')}\n`;
}
