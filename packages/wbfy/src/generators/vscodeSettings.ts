import path from 'node:path';

import merge from 'deepmerge';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';
import { sortKeys } from '../utils/objectUtil.js';
import { doesContainJava } from '../utils/packageCapabilities.js';
import { promisePool } from '../utils/promisePool.js';

const prettierVscodeExtension = 'esbenp.prettier-vscode';
const oxcVscodeExtension = 'oxc.oxc-vscode';

const excludeFilePatterns = [
  '**/.git/objects/**',
  '**/.git/subtree-cache/**',
  '**/node_modules/**',
  '**/tmp/**',
  '**/temp/**',
  '**/dist/**',
];

export async function generateVscodeSettings(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateVscodeSettings', async () => {
    const filePath = path.resolve(config.dirPath, '.vscode', 'settings.json');
    const existingContent = await fsUtil.readFileIfExists(filePath);
    if (existingContent === undefined || jsoncUtil.isTriviaOnly(existingContent)) return;
    // .vscode/settings.json is JSONC by definition; JSON.parse would make wbfy silently skip
    // commented files, leaving the settings it intends to remove in place.
    const parsedSettings = jsoncUtil.parseObjectIgnoringError<object>(existingContent);
    if (!parsedSettings) {
      console.warn(`Skipped updating ${filePath} because the existing content is not parsable as JSONC.`);
      return;
    }
    const originalSettingsJson = JSON.stringify(sortKeys(structuredClone(parsedSettings) as Record<string, unknown>));
    let settings = parsedSettings;
    for (const excludeFilePattern of excludeFilePatterns) {
      settings = merge.all([settings, excludeSetting(excludeFilePattern)]);
    }
    if (config.doesContainPoetryLock || config.doesContainUvLock) {
      settings = merge.all([settings, excludeSetting('**/.venv/**')]);
    }
    if (config.depending.next) {
      settings = merge.all([settings, excludeSetting('**/.next/**')]);
    }
    // LLMによるvibe codingでは、自動フォーマットやコードアクションを無効化することで
    // 生成されたコードの元の形式を維持できる
    if ('editor.codeActionsOnSave' in settings) {
      delete settings['editor.codeActionsOnSave'];
    }
    if ('editor.formatOnSave' in settings) {
      delete settings['editor.formatOnSave'];
    }
    // Only Java repositories keep Prettier (via prettier-plugin-java); everywhere else the
    // formatter is oxfmt, so a leftover prettier-vscode formatter setting (including per-language
    // overrides) must follow the migration to the oxc extension.
    if (!doesContainJava(config)) {
      replacePrettierVscodeValues(settings);
    }
    sortKeys(settings as Record<string, unknown>);
    // Skip the write when nothing changes semantically, so JSONC comments and formatting in an
    // already-clean settings.json survive wbfy runs.
    if (JSON.stringify(settings) === originalSettingsJson) return;
    const newContent = JSON.stringify(settings, undefined, 2);
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}

/**
 * Replaces a stale prettier-vscode recommendation in an existing .vscode/extensions.json with the
 * oxc extension (Java repositories keep Prettier, so theirs is left untouched). The file is never
 * created when absent.
 */
export async function fixVscodeExtensions(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixVscodeExtensions', async () => {
    if (doesContainJava(config)) return;
    const filePath = path.resolve(config.dirPath, '.vscode', 'extensions.json');
    const existingContent = await fsUtil.readFileIfExists(filePath);
    if (existingContent === undefined) return;
    const parsed = jsoncUtil.parseObjectIgnoringError<{ recommendations?: unknown }>(existingContent);
    if (!parsed || !Array.isArray(parsed.recommendations) || !parsed.recommendations.includes(prettierVscodeExtension))
      return;
    const recommendations = [
      ...new Set(
        parsed.recommendations.map((extension: unknown) =>
          extension === prettierVscodeExtension ? oxcVscodeExtension : extension
        )
      ),
    ];
    const newContent = JSON.stringify({ ...parsed, recommendations }, undefined, 2);
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}

// Values only (e.g. `editor.defaultFormatter` and its per-language `[typescript]` overrides):
// keys never carry the extension identifier.
function replacePrettierVscodeValues(node: object): void {
  for (const [key, value] of Object.entries(node)) {
    if (value === prettierVscodeExtension) {
      (node as Record<string, unknown>)[key] = oxcVscodeExtension;
    } else if (value && typeof value === 'object') {
      replacePrettierVscodeValues(value);
    }
  }
}

function excludeSetting(excludeFilePattern: string): object {
  return {
    'files.watcherExclude': {
      [excludeFilePattern]: true,
    },
  };
}
