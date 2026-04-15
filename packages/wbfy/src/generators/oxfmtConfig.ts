import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

const oxfmtConfig = {
  $schema: './node_modules/oxfmt/configuration_schema.json',
  ignorePatterns: [
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
  ],
  printWidth: 120,
  singleQuote: true,
  trailingComma: 'es5',
};

export async function generateOxfmtConfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxfmtConfig', async () => {
    // Oxfmt does not support extending a shared config, so wbfy writes the resolved settings directly.
    const filePath = path.resolve(config.dirPath, '.oxfmtrc.json');
    await promisePool.run(() => fsUtil.generateFile(filePath, `${JSON.stringify(oxfmtConfig, undefined, 2)}\n`));
  });
}
