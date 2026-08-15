import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'smol-toml';
import { expect, test } from 'vitest';

import { ensureWbEnvDefinitions, insertWbEnvIntoFnoxToml } from '../../src/generators/wbEnv.js';

import { createConfig } from '../helpers/testConfig.js';

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

test('inserts only the missing key into a section that already defines the other one', () => {
  const wbEnvOnly = insertWbEnvIntoFnoxToml(fnoxTomlWithoutWbEnv, false) ?? '';
  const withNextPublic = insertWbEnvIntoFnoxToml(wbEnvOnly, true) ?? '';
  const settings = parse(withNextPublic) as FnoxSubtree;
  expect(settings.secrets?.WB_ENV).toEqual({ default: 'development' });
  expect(settings.secrets?.NEXT_PUBLIC_WB_ENV).toEqual({ default: 'development' });
  // A re-inserted WB_ENV would be a duplicate key, which makes the TOML unparsable and the
  // insertion bail out with undefined.
  expect(settings.profiles?.test?.secrets?.NEXT_PUBLIC_WB_ENV).toEqual({ default: 'test' });
});

test('inserts no explanatory comment and removes the one written by earlier wbfy versions', () => {
  const inserted = insertWbEnvIntoFnoxToml(fnoxTomlWithoutWbEnv, false) ?? '';
  expect(inserted).not.toContain('# CI sets WB_ENV');

  const withLegacyComment = inserted.replace(
    '[secrets]\n',
    '[secrets]\n# CI sets WB_ENV as a process env var, which wins over fnox; these defaults only fill it locally.\n'
  );
  const migrated = insertWbEnvIntoFnoxToml(withLegacyComment, false) ?? '';
  expect(migrated).not.toContain('# CI sets WB_ENV');
  // The migration is a pure comment removal: values stay untouched and a second pass is a no-op.
  expect(parse(migrated)).toEqual(parse(withLegacyComment));
  expect(insertWbEnvIntoFnoxToml(migrated, false)).toBe(migrated);
});

test('refuses to edit an unparsable fnox.toml', () => {
  expect(insertWbEnvIntoFnoxToml('[secrets\nbroken', false)).toBeUndefined();
});

test('ensureWbEnvDefinitions updates the root fnox.toml and skips non-fnox repositories', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-wbenv-'));
  try {
    fs.writeFileSync(path.join(tempDirPath, '.env'), 'PORT=3000\n');
    const rootConfig = createConfig({ dirPath: tempDirPath, isRoot: true });

    // Without a root fnox.toml, nothing happens (no fnox.toml is created, .env is untouched).
    await ensureWbEnvDefinitions(rootConfig, [rootConfig]);
    expect(fs.existsSync(path.join(tempDirPath, 'fnox.toml'))).toBe(false);
    expect(fs.readFileSync(path.join(tempDirPath, '.env'), 'utf8')).toBe('PORT=3000\n');

    fs.writeFileSync(path.join(tempDirPath, 'fnox.toml'), fnoxTomlWithoutWbEnv);
    await ensureWbEnvDefinitions(rootConfig, [rootConfig]);
    const settings = parse(fs.readFileSync(path.join(tempDirPath, 'fnox.toml'), 'utf8')) as FnoxSubtree;
    expect(settings.secrets?.WB_ENV).toEqual({ default: 'development' });
    expect(settings.profiles?.production?.secrets?.WB_ENV).toEqual({ default: 'production' });
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});
