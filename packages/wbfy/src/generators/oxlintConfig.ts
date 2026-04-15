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
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'biome.jsonc'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.mjs'), { force: true })),
      promisePool.run(() => fsUtil.generateFile(filePath, configContent)),
    ]);
  });
}

const configContent = `import { defineConfig } from 'oxlint';

declare const process: {
  getBuiltinModule(name: 'fs'): {
    readFileSync(path: string, encoding: 'utf8'): string;
  };
  getBuiltinModule(name: 'module'): {
    createRequire(url: string): {
      resolve(specifier: string): string;
    };
  };
};

const fs = process.getBuiltinModule('fs');
const { createRequire } = process.getBuiltinModule('module');
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
