import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

export async function generateOxlintConfig(config: PackageConfig, _rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxlintConfig', async () => {
    const filePath = path.resolve(config.dirPath, 'oxlint.config.ts');
    const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;

    const promises = [
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
    ];
    if (!existingContent || legacyConfigContents.has(existingContent)) {
      promises.push(promisePool.run(() => fsUtil.generateFile(filePath, configContent)));
    }
    await Promise.all(promises);
  });
}

const legacyConfigContents = new Set([
  `import config from '@willbooster/oxlint-config';

export default config;
`,
  `import config from '@willbooster/oxlint-config';

// @willbooster/oxlint-config currently enables a Unicorn rule that oxlint does
// not ship yet. Drop this shim after the shared config package removes it or
// oxlint adds support.
delete config.rules?.['unicorn/consistent-template-literal-escape'];

export default config;
`,
]);

const configContent = `import config from '@willbooster/oxlint-config';

// @willbooster/oxlint-config currently enables a Unicorn rule that oxlint does
// not ship yet. Drop this shim after the shared config package removes it or
// oxlint adds support.
const rules = (config as { rules?: Record<string, unknown> }).rules;
delete rules?.['unicorn/consistent-template-literal-escape'];

export default config;
`;
