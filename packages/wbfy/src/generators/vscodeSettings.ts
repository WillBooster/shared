import path from 'node:path';

import merge from 'deepmerge';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';
import { sortKeys } from '../utils/objectUtil.js';
import { promisePool } from '../utils/promisePool.js';

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
    if (existingContent === undefined || !existingContent.trim()) return;
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
    sortKeys(settings as Record<string, unknown>);
    // Skip the write when nothing changes semantically, so JSONC comments and formatting in an
    // already-clean settings.json survive wbfy runs.
    if (JSON.stringify(settings) === originalSettingsJson) return;
    const newContent = JSON.stringify(settings, undefined, 2);
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}

function excludeSetting(excludeFilePattern: string): object {
  return {
    'files.watcherExclude': {
      [excludeFilePattern]: true,
    },
  };
}
