import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

export async function fixNextConfigJson(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixNextConfigJson', async () => {
    const filePath = ['js', 'mjs', 'cjs']
      .map((ext) => path.resolve(config.dirPath, `next.config.${ext}`))
      .find((p) => fs.existsSync(p));
    if (!filePath) return;

    const oldContent = await fs.promises.readFile(filePath, 'utf8');
    // Replace the JSON object from the file
    const newContent = oldContent.replace(/=\s*{([\S\s]*)};/, (_, settingsText: string) => {
      if (!settingsText.includes('eslint:')) {
        settingsText += 'eslint: { ignoreDuringBuilds: true },';
      }
      if (!settingsText.includes('typescript:')) {
        settingsText += 'typescript: { ignoreBuildErrors: true },';
      }
      return `= {${settingsText}};`;
    });
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}
