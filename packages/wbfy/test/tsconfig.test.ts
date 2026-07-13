import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateTsconfig } from '../src/generators/tsconfig.js';
import type { PackageConfig } from '../src/packageConfig.js';
import { promisePool } from '../src/utils/promisePool.js';

import { createConfig } from './testConfig.js';

test('keeps the bundler pair for Vite-dependent packages', async () => {
  const compilerOptions = await generateCompilerOptionsFrom(
    { compilerOptions: { module: 'ESNext', moduleResolution: 'bundler' } },
    { vite: true }
  );
  expect(compilerOptions.moduleResolution).toBe('bundler');
  expect(compilerOptions.module).toBe('ESNext');
});

test('keeps the bundler pair for Tauri-dependent packages', async () => {
  const compilerOptions = await generateCompilerOptionsFrom(
    { compilerOptions: { moduleResolution: 'Bundler' } },
    { tauri: true }
  );
  expect(compilerOptions.moduleResolution).toBe('Bundler');
  expect(compilerOptions.module).toBe('ESNext');
});

test('drops a leftover bundler resolution and esnext module regardless of casing', async () => {
  const compilerOptions = await generateCompilerOptionsFrom({
    compilerOptions: { module: 'esnext', moduleResolution: 'Bundler' },
  });
  expect(compilerOptions.module).toBeUndefined();
  expect(compilerOptions.moduleResolution).toBeUndefined();
});

test('keeps an existing Preserve module kind for Vite-dependent packages', async () => {
  const compilerOptions = await generateCompilerOptionsFrom(
    { compilerOptions: { module: 'Preserve', moduleResolution: 'bundler' } },
    { vite: true }
  );
  expect(compilerOptions.module).toBe('Preserve');
  expect(compilerOptions.moduleResolution).toBe('bundler');
});

test('drops a leftover bundler resolution paired with CommonJS in non-bundler packages', async () => {
  const compilerOptions = await generateCompilerOptionsFrom({
    compilerOptions: { module: 'CommonJS', moduleResolution: 'bundler' },
  });
  expect(compilerOptions.moduleResolution).toBeUndefined();
});

test('drops removed node10 resolver spellings regardless of casing', async () => {
  const compilerOptions = await generateCompilerOptionsFrom({ compilerOptions: { moduleResolution: 'Node10' } });
  expect(compilerOptions.moduleResolution).toBeUndefined();
});

async function generateCompilerOptionsFrom(
  existingTsconfig: object,
  dependingOverrides: Partial<PackageConfig['depending']> = {}
): Promise<Record<string, unknown>> {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-tsconfig-'));
  try {
    fs.writeFileSync(path.join(tempDirPath, 'tsconfig.json'), JSON.stringify(existingTsconfig));
    const config = createConfig({ dirPath: tempDirPath, isRoot: true, doesContainTypeScript: true });
    Object.assign(config.depending, dependingOverrides);
    await generateTsconfig(config);
    await promisePool.promiseAll();
    const generated = JSON.parse(fs.readFileSync(path.join(tempDirPath, 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: Record<string, unknown>;
    };
    return generated.compilerOptions ?? {};
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
}
