import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
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
    try {
      const filePath = path.resolve(config.dirPath, '.vscode', 'settings.json');
      const existingContent = await fs.promises.readFile(filePath, 'utf8');
      let settings = JSON.parse(existingContent) as object;
      for (const excludeFilePattern of excludeFilePatterns) {
        settings = merge.all([settings, excludeSetting(excludeFilePattern)]);
      }
      if (config.doesContainPoetryLock) {
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
      const newContent = JSON.stringify(settings, undefined, 2);
      await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
    } catch {
      // do nothing
    }
  });
}

function excludeSetting(excludeFilePattern: string): object {
  return {
    'files.watcherExclude': {
      [excludeFilePattern]: true,
    },
  };
}
