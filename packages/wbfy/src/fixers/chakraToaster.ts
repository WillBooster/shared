import fs from 'node:fs/promises';

import fg from 'fast-glob';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';

export async function fixChakraToaster(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixChakraToaster', async () => {
    if (!config.depending.chakra) return;

    const filePaths = await fg.glob('**/toaster.{ts,tsx}', {
      absolute: true,
      cwd: config.dirPath,
      ignore: ['**/.*/**', '**/node_modules/**'],
    });
    for (const filePath of filePaths) {
      const content = await fs.readFile(filePath, 'utf8');
      if (
        content.includes('CreateToasterReturn') ||
        !content.includes("from '@chakra-ui/react'") ||
        !content.includes('export const toaster = createToaster(')
      ) {
        continue;
      }
      const updatedContent = content
        .replace(
          /^import .* from '@chakra-ui\/react';$/mu,
          "$&\nimport type { CreateToasterReturn } from '@chakra-ui/react';"
        )
        .replace('export const toaster = createToaster(', 'export const toaster: CreateToasterReturn = createToaster(');
      if (updatedContent !== content) await fsUtil.generateFile(filePath, updatedContent);
    }
  });
}
