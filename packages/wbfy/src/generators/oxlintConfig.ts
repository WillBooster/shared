import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';
import { promisePool } from '../utils/promisePool.js';

export async function generateOxlintConfig(config: PackageConfig, rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxlintConfig', async () => {
    const configPath = path.relative(
      config.dirPath,
      path.resolve(rootConfig.dirPath, 'node_modules', '@willbooster', 'oxlint-config', '.oxlintrc.json')
    );
    const newSettings: object = {
      extends: [configPath.startsWith('.') ? configPath : `./${configPath}`],
      ignorePatterns: ['**/test/fixtures/**', '**/test-fixtures/**'],
      options: {
        typeAware: false,
        typeCheck: false,
      },
      rules: {
        'unicorn/no-nested-ternary': 'off',
        'unicorn/number-literal-case': 'off',
        'react-perf/jsx-no-new-object-as-prop': 'off',
        'react/react-in-jsx-scope': 'off',
        'unicorn/prefer-structured-clone': 'off',
      },
    };
    const filePath = path.resolve(config.dirPath, '.oxlintrc.json');
    let mergedSettings = newSettings;

    try {
      const oldContent = await fs.promises.readFile(filePath, 'utf8');
      const oldSettings = JSON.parse(oldContent) as object;
      if (
        'rules' in oldSettings &&
        oldSettings.rules &&
        typeof oldSettings.rules === 'object' &&
        'typescript/tsconfig' in oldSettings.rules
      ) {
        Reflect.deleteProperty(oldSettings.rules, 'typescript/tsconfig');
      }
      mergedSettings = merge.all([newSettings, oldSettings, newSettings], { arrayMerge: overwriteMerge });
    } catch {
      // do nothing
    }

    await Promise.all([
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'biome.jsonc'), { force: true })),
      promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.mjs'), { force: true })),
      promisePool.run(() => fsUtil.generateFile(filePath, JSON.stringify(mergedSettings, undefined, 2))),
    ]);
  });
}
