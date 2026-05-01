import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { generateOxlintConfig } from '../src/generators/oxlintConfig.js';
import type { PackageConfig } from '../src/packageConfig.js';
import { promisePool } from '../src/utils/promisePool.js';
import { createConfig as createBaseConfig } from './testConfig.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dirPath) => fs.promises.rm(dirPath, { force: true, recursive: true })));
  tempDirs.length = 0;
});

test('overwrites unmarked oxlint config with managed blocks', async () => {
  const dirPath = createTempDir();
  await fs.promises.writeFile(
    path.join(dirPath, 'oxlint.config.ts'),
    `import config from '@willbooster/oxlint-config';

config.ignorePatterns?.push('generated/**');

export default config;
`
  );

  await generateOxlintConfig(createConfig({ dirPath }), createConfig({ dirPath }));
  await promisePool.promiseAll();

  const content = await readOxlintConfig(dirPath);
  expect(content).toContain(
    '// @ts-nocheck -- Tool config files may be loaded as CommonJS before the package opts into ESM.'
  );
  expect(content).toContain('// wbfy:start oxlint-base');
  expect(content).toContain('// wbfy:start oxlint-export');
  expect(content).not.toContain("config.ignorePatterns?.push('generated/**');");
});

test('updates only managed blocks in marked oxlint config', async () => {
  const dirPath = createTempDir();
  await fs.promises.writeFile(
    path.join(dirPath, 'oxlint.config.ts'),
    `// wbfy:start oxlint-base
const staleConfig = require('@willbooster/oxlint-config');
// wbfy:end oxlint-base

config.ignorePatterns?.push('generated/**');

// wbfy:start oxlint-export
module.exports = staleConfig;
// wbfy:end oxlint-export
`
  );

  await generateOxlintConfig(createConfig({ dirPath }), createConfig({ dirPath }));
  await promisePool.promiseAll();

  const content = await readOxlintConfig(dirPath);
  expect(content).toContain(
    '// @ts-nocheck -- Tool config files may be loaded as CommonJS before the package opts into ESM.'
  );
  expect(content).toContain("import config from '@willbooster/oxlint-config';");
  expect(content).toContain("config.ignorePatterns?.push('generated/**');");
  expect(content).toContain('export default config;');
  expect(content).not.toContain('staleConfig');
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-oxlint-config-'));
  tempDirs.push(tempDir);
  return tempDir;
}

async function readOxlintConfig(dirPath: string): Promise<string> {
  return fs.promises.readFile(path.join(dirPath, 'oxlint.config.ts'), 'utf8');
}

function createConfig(overrides: Partial<PackageConfig> = {}): PackageConfig {
  return createBaseConfig({
    isRoot: true,
    doesContainPackageJson: true,
    doesContainTypeScript: true,
    ...overrides,
  });
}
