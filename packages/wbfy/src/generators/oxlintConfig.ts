import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

const ignorePatterns = [
  '**/.agents/**',
  '**/.claude/**',
  '**/.devcontainer/**',
  '**/.idea/AugmentWebviewStateStore.xml',
  '**/.idea/copilot.*/**',
  '**/.idea/copilot/**',
  '**/.playwright-cli/**',
  '**/.serena/**',
  '**/.tmp/**',
  '**/.venv/**',
  '**/.yarn/**',
  '**/3rd-party/**',
  '**/@types/**',
  '**/@willbooster/**',
  '**/__generated__/**',
  '**/android/**',
  '**/bin/**',
  '**/build/**',
  '**/coverage/**',
  '**/dist/**',
  '**/ios/**',
  '**/no-format/**',
  '**/node_modules/**',
  '**/temp/**',
  '**/tmp/**',
  '**/test-fixtures/**',
  '**/test-results/**',
  '**/test/fixtures/**',
  '**/.aider*',
  '**/.env.production',
  '**/.pnp.js',
  '**/*/mount/*.hash',
  '**/*.d.ts',
  '**/*.min.*js',
];

export async function generateOxlintConfig(config: PackageConfig, rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxlintConfig', async () => {
    const configPath = path.relative(
      config.dirPath,
      path.resolve(rootConfig.dirPath, 'node_modules', '@willbooster', 'oxlint-config', '.oxlintrc.jsonc')
    );
    const newSettings: object = {
      extends: [configPath.startsWith('.') ? configPath : `./${configPath}`],
      ignorePatterns,
    };
    const filePath = path.resolve(config.dirPath, '.oxlintrc.json');

    await Promise.all([
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'biome.jsonc'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.mjs'), { force: true })),
      promisePool.run(() => fsUtil.generateFile(filePath, JSON.stringify(newSettings, undefined, 2))),
    ]);
  });
}
