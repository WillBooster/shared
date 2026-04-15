import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

export async function generateOxlintConfig(config: PackageConfig, _rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxlintConfig', async () => {
    const filePath = path.resolve(config.dirPath, 'oxlint.config.ts');

    await Promise.all([
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.oxlintrc.json'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'biome.json'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'biome.jsonc'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.cjs'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.js'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.json'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.yaml'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.yml'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.cjs'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.js'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.mjs'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.ts'), { force: true })),
      promisePool.run(() => fsUtil.generateFile(filePath, configContent)),
    ]);
  });
}

const configContent = `import fs from 'node:fs';
import { createRequire } from 'node:module';

import { defineConfig } from 'oxlint';

const require = createRequire(import.meta.url);
const sharedConfigPath = require.resolve('@willbooster/oxlint-config');
const sharedConfig = parseJsonc(fs.readFileSync(sharedConfigPath, 'utf8')) as { ignorePatterns?: string[] };

export default defineConfig({
  extends: [sharedConfig],
  ignorePatterns: [...(sharedConfig.ignorePatterns ?? []), 'oxlint.config.ts'],
});

function parseJsonc(text: string): unknown {
  // The shared config only uses full-line // comments, so we avoid pulling in
  // a JSONC parser just to read ignorePatterns.
  const json = text.replaceAll(/^\\s*\\/\\/.*$/gmu, '').replaceAll(/,\\s*([}\\]])/gu, '$1');
  return JSON.parse(json);
}
`;
