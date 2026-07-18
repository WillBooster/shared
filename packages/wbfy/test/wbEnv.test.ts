import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'smol-toml';
import { expect, test } from 'vitest';

import { ensureWbEnvDefinitions, insertWbEnvIntoEnvFile, insertWbEnvIntoFnoxToml } from '../src/generators/wbEnv.js';

import { createConfig } from './testConfig.js';

const fnoxTomlWithoutWbEnv = `[providers.age]
type = "age"
recipients = [
  "age1example", # exkazuu
]

[secrets]
PORT = { default = "3000" }

[profiles.test.secrets]
API_KEY = { provider = "age", value = "abc" }

[profiles.production.secrets]
API_KEY = { provider = "age", value = "def" }
`;

interface FnoxSubtree {
  secrets?: Record<string, { default?: string }>;
  profiles?: Record<string, { secrets?: Record<string, { default?: string }> } | undefined>;
}

test('inserts WB_ENV into the base secrets and every profile of a fnox.toml', () => {
  const updated = insertWbEnvIntoFnoxToml(fnoxTomlWithoutWbEnv, false);
  expect(updated).toBeDefined();
  const settings = parse(updated ?? '') as FnoxSubtree;
  expect(settings.secrets?.WB_ENV).toEqual({ default: 'development' });
  expect(settings.profiles?.test?.secrets?.WB_ENV).toEqual({ default: 'test' });
  expect(settings.profiles?.production?.secrets?.WB_ENV).toEqual({ default: 'production' });
  // The staging profile does not exist and must not be created.
  expect(settings.profiles?.staging).toBeUndefined();
  // Existing entries and formatting survive.
  expect(updated).toContain('PORT = { default = "3000" }');
  expect(updated).toContain('# exkazuu');
});

test('creates missing profile sections for the standard modes', () => {
  const minimal = '[secrets]\nPORT = { default = "3000" }\n';
  const updated = insertWbEnvIntoFnoxToml(minimal, false);
  const settings = parse(updated ?? '') as FnoxSubtree;
  expect(settings.secrets?.WB_ENV).toEqual({ default: 'development' });
  expect(settings.profiles?.test?.secrets?.WB_ENV).toEqual({ default: 'test' });
  expect(settings.profiles?.production?.secrets?.WB_ENV).toEqual({ default: 'production' });
});

test('completes an existing staging profile', () => {
  const withStaging = `${fnoxTomlWithoutWbEnv}
[profiles.staging.secrets]
API_KEY = { provider = "age", value = "ghi" }
`;
  const updated = insertWbEnvIntoFnoxToml(withStaging, false);
  const settings = parse(updated ?? '') as FnoxSubtree;
  expect(settings.profiles?.staging?.secrets?.WB_ENV).toEqual({ default: 'staging' });
});

test('adds NEXT_PUBLIC_WB_ENV for Next.js/vinext repositories', () => {
  const updated = insertWbEnvIntoFnoxToml(fnoxTomlWithoutWbEnv, true);
  const settings = parse(updated ?? '') as FnoxSubtree;
  expect(settings.secrets?.NEXT_PUBLIC_WB_ENV).toEqual({ default: 'development' });
  expect(settings.profiles?.test?.secrets?.NEXT_PUBLIC_WB_ENV).toEqual({ default: 'test' });
  expect(settings.profiles?.production?.secrets?.NEXT_PUBLIC_WB_ENV).toEqual({ default: 'production' });
});

test('is idempotent and leaves already-defined values untouched', () => {
  const firstPass = insertWbEnvIntoFnoxToml(fnoxTomlWithoutWbEnv, true) ?? '';
  expect(insertWbEnvIntoFnoxToml(firstPass, true)).toBe(firstPass);

  const customized = firstPass.replace('WB_ENV = { default = "test" }', 'WB_ENV = { default = "custom-test" }');
  const secondPass = insertWbEnvIntoFnoxToml(customized, true);
  expect(secondPass).toBe(customized);
});

test('refuses to edit an unparsable fnox.toml', () => {
  expect(insertWbEnvIntoFnoxToml('[secrets\nbroken', false)).toBeUndefined();
});

test('appends missing WB_ENV assignments to legacy .env mode files', () => {
  expect(insertWbEnvIntoEnvFile('PORT=3000\n', 'test', false)).toBe('PORT=3000\nWB_ENV=test\n');
  expect(insertWbEnvIntoEnvFile('', 'production', true)).toBe('WB_ENV=production\nNEXT_PUBLIC_WB_ENV=production\n');
});

test('leaves existing legacy WB_ENV assignments untouched (idempotent)', () => {
  const content = 'WB_ENV=custom\nexport NEXT_PUBLIC_WB_ENV=custom\n';
  expect(insertWbEnvIntoEnvFile(content, 'staging', true)).toBe(content);
  const inserted = insertWbEnvIntoEnvFile('PORT=3000\n', 'staging', true);
  expect(insertWbEnvIntoEnvFile(inserted, 'staging', true)).toBe(inserted);
});

test('ensureWbEnvDefinitions updates existing legacy mode files only', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-wbenv-'));
  try {
    fs.writeFileSync(path.join(tempDirPath, '.env'), 'PORT=3000\n');
    fs.writeFileSync(path.join(tempDirPath, '.env.test'), '');
    const rootConfig = createConfig({ dirPath: tempDirPath, isRoot: true });
    await ensureWbEnvDefinitions(rootConfig, [rootConfig]);
    expect(fs.readFileSync(path.join(tempDirPath, '.env'), 'utf8')).toBe('PORT=3000\nWB_ENV=development\n');
    expect(fs.readFileSync(path.join(tempDirPath, '.env.test'), 'utf8')).toBe('WB_ENV=test\n');
    expect(fs.existsSync(path.join(tempDirPath, '.env.production'))).toBe(false);
    expect(fs.existsSync(path.join(tempDirPath, '.env.staging'))).toBe(false);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('ensureWbEnvDefinitions prefers fnox.toml over legacy .env files', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-wbenv-'));
  try {
    fs.writeFileSync(path.join(tempDirPath, 'fnox.toml'), fnoxTomlWithoutWbEnv);
    fs.writeFileSync(path.join(tempDirPath, '.env'), 'PORT=3000\n');
    const rootConfig = createConfig({ dirPath: tempDirPath, isRoot: true });
    await ensureWbEnvDefinitions(rootConfig, [rootConfig]);
    const settings = parse(fs.readFileSync(path.join(tempDirPath, 'fnox.toml'), 'utf8')) as FnoxSubtree;
    expect(settings.secrets?.WB_ENV).toEqual({ default: 'development' });
    // Legacy files are left alone while fnox.toml exists.
    expect(fs.readFileSync(path.join(tempDirPath, '.env'), 'utf8')).toBe('PORT=3000\n');
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});
