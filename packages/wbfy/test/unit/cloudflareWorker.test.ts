import { expect, test } from 'bun:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { generateGitignore } from '../../src/generators/gitignore.js';
import { generatePackageJson } from '../../src/generators/packageJson.js';
import { generateTsconfig } from '../../src/generators/tsconfig.js';
import { findUnconvertedWorkerDirPaths, getPackageConfig } from '../../src/packageConfig.js';
import { fsUtil } from '../../src/utils/fsUtil.js';

test('wires the generated cf output of a package that owns cloudflare.config.ts', async () => {
  const dirPath = createPackage({
    'cloudflare.config.ts': 'export default {};',
    'package.json': JSON.stringify({ name: 'worker', devDependencies: { cf: '1.0.0' } }),
    'tsconfig.json': JSON.stringify({ include: ['src/**/*'] }),
  });
  try {
    fsUtil.setRootDirPath(dirPath);
    const config = await getPackageConfig(dirPath, { isRoot: true });
    assert.ok(config);
    expect(findUnconvertedWorkerDirPaths([config])).toEqual([]);

    await generateGitignore(config, config);
    await generatePackageJson(config, config, true);
    await generateTsconfig(config);

    // Everything cf generates is ignored, so a fresh install must regenerate the types and the
    // type check must be able to see them.
    expect(fs.readFileSync(path.join(dirPath, '.gitignore'), 'utf8')).toMatch(/^\.cloudflare\/$/mu);
    const packageJson = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.postinstall).toBe('bun wb gen-code');
    const tsconfig = JSON.parse(fs.readFileSync(path.join(dirPath, 'tsconfig.json'), 'utf8')) as {
      include?: string[];
    };
    expect(tsconfig.include).toContain('.cloudflare/types/**/*');
  } finally {
    fsUtil.setRootDirPath(undefined);
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});

test('reports a Worker that still has only a wrangler config as unconverted', async () => {
  const dirPath = createPackage({
    'package.json': JSON.stringify({ name: 'worker', devDependencies: { wrangler: '4.0.0' } }),
    'wrangler.jsonc': '{}',
  });
  try {
    const config = await getPackageConfig(dirPath, { isRoot: true });
    assert.ok(config);
    expect(findUnconvertedWorkerDirPaths([config])).toEqual([dirPath]);

    // The conversion keeps the wrangler config until the first cf deploy, so it must not block wbfy.
    fs.writeFileSync(path.join(dirPath, 'cloudflare.config.ts'), 'export default {};');
    const convertedConfig = await getPackageConfig(dirPath, { isRoot: true });
    assert.ok(convertedConfig);
    expect(findUnconvertedWorkerDirPaths([convertedConfig])).toEqual([]);
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});

function createPackage(files: Record<string, string>): string {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(tempRootPath, { recursive: true });
  const dirPath = fs.mkdtempSync(path.join(tempRootPath, 'cloudflare-worker-'));
  for (const [fileName, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dirPath, fileName), content);
  }
  return dirPath;
}
