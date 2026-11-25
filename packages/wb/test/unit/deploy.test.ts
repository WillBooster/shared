import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseDotenv } from 'dotenv';

import {
  readCloudflareEnvFiles,
  selectDeclaredSecrets,
  selectInheritedRemoteSecretNames,
} from '../../src/commands/deploy.js';
import { quoteDotenvValue } from '../../src/commands/genDevVars.js';
import { resolveCloudflareConfig } from '../../src/utils/cloudflareConfig.js';
import { createCloudflareProjectDir } from '../helpers/cloudflareProject.js';

describe('resolveCloudflareConfig', () => {
  let dirPath: string;

  beforeEach(async () => {
    dirPath = await createCloudflareProjectDir();
  });

  afterEach(async () => {
    await fs.rm(dirPath, { force: true, recursive: true });
  });

  it('evaluates the config for the given mode, defaulting to WB_ENV', async () => {
    await fs.writeFile(
      path.join(dirPath, 'cloudflare.config.ts'),
      `import { bindings, defineConfig } from 'cf/config';

      export default defineConfig(({ mode }) => ({
        accountId: 'acc-1',
        worker: {
          name: mode === 'staging' ? 'my-app-staging' : 'my-app',
          compatibilityDate: '2026-09-01',
          env: {
            WB_ENV: bindings.text(mode ?? 'development'),
            LIMITS: bindings.json({ max: 3 }),
            AUTH_SECRET: bindings.secret(),
            DB: bindings.d1({ name: \`my-app-\${mode}\`, id: mode === 'staging' ? 'stg-id' : 'prod-id' }),
            CACHE: bindings.kv({ id: 'kv-id' }),
            OMITTED: mode === 'staging' && bindings.secret(),
          },
        },
      }));`
    );

    expect(resolveCloudflareConfig({ dirPath, env: process.env }, 'production')).toEqual({
      workerName: 'my-app',
      accountId: 'acc-1',
      vars: { WB_ENV: 'production', LIMITS: { max: 3 } },
      secretNames: ['AUTH_SECRET'],
      envKeys: ['WB_ENV', 'LIMITS', 'AUTH_SECRET', 'DB', 'CACHE'],
      d1Databases: [{ binding: 'DB', name: 'my-app-production', id: 'prod-id' }],
      hasContainers: false,
    });
    const staging = resolveCloudflareConfig({ dirPath, env: { ...process.env, WB_ENV: 'staging' } });
    expect(staging?.workerName).toBe('my-app-staging');
    expect(staging?.secretNames).toEqual(['AUTH_SECRET', 'OMITTED']);
    expect(staging?.d1Databases).toEqual([{ binding: 'DB', name: 'my-app-staging', id: 'stg-id' }]);
  });

  it('returns undefined without a config and throws for one that cannot be evaluated', async () => {
    expect(resolveCloudflareConfig({ dirPath, env: process.env }, 'production')).toBeUndefined();

    await fs.writeFile(path.join(dirPath, 'cloudflare.config.ts'), `throw new Error('Migration incomplete.');`);
    expect(() => resolveCloudflareConfig({ dirPath, env: process.env }, 'production')).toThrow('Migration incomplete.');
  });
});

describe('readCloudflareEnvFiles', () => {
  let rootDirPath: string;
  let dirPath: string;

  beforeEach(async () => {
    rootDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-deploy-test-'));
    dirPath = path.join(rootDirPath, 'packages', 'server');
    await fs.mkdir(dirPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(rootDirPath, { force: true, recursive: true });
  });

  it('reads the file at the monorepo root as well as beside the Worker config', async () => {
    expect(readCloudflareEnvFiles(dirPath, rootDirPath)).toEqual({});

    // file_path_1 is repo-relative, so CI commonly writes the token at the root even though the
    // Worker lives in a workspace; reading only the workspace would silently lose the token.
    await fs.writeFile(path.join(rootDirPath, '.env.cloudflare'), 'CLOUDFLARE_API_TOKEN=root-token\n');
    expect(readCloudflareEnvFiles(dirPath, rootDirPath)).toEqual({ CLOUDFLARE_API_TOKEN: 'root-token' });

    await fs.writeFile(path.join(dirPath, '.env.cloudflare'), 'CLOUDFLARE_API_TOKEN=own-token\n');
    // Nearer wins.
    expect(readCloudflareEnvFiles(dirPath, rootDirPath)).toEqual({ CLOUDFLARE_API_TOKEN: 'own-token' });
  });

  it('reads a non-monorepo project once rather than twice', async () => {
    await fs.writeFile(path.join(rootDirPath, '.env.cloudflare'), 'CLOUDFLARE_API_TOKEN=token\n');
    expect(readCloudflareEnvFiles(rootDirPath, rootDirPath)).toEqual({ CLOUDFLARE_API_TOKEN: 'token' });
  });

  it('ignores the root file when the caller passes no root directory', async () => {
    // A caller that isolates the workspace by passing rootDirPath as undefined must not
    // authenticate with the root's token.
    await fs.writeFile(path.join(rootDirPath, '.env.cloudflare'), 'CLOUDFLARE_API_TOKEN=root-token\n');
    expect(readCloudflareEnvFiles(dirPath, undefined)).toEqual({});

    await fs.writeFile(path.join(dirPath, '.env.cloudflare'), 'CLOUDFLARE_API_TOKEN=own-token\n');
    expect(readCloudflareEnvFiles(dirPath, undefined)).toEqual({ CLOUDFLARE_API_TOKEN: 'own-token' });
  });
});

describe('selectDeclaredSecrets', () => {
  it('prefers exported values, keeps empty values, and reports undeclared sources as missing', () => {
    expect(
      selectDeclaredSecrets(
        ['AUTH_SECRET', 'CLEARED_SECRET', 'CI_ONLY_SECRET', 'MISSING_SECRET'],
        { AUTH_SECRET: 'from-fnox', CLEARED_SECRET: '', UNDECLARED: 'never-pushed' },
        { AUTH_SECRET: 'exported', CI_ONLY_SECRET: 'from-ci' }
      )
    ).toEqual({
      missingSecretNames: ['MISSING_SECRET'],
      secrets: { AUTH_SECRET: 'exported', CLEARED_SECRET: '', CI_ONLY_SECRET: 'from-ci' },
    });
  });
});

describe('selectInheritedRemoteSecretNames', () => {
  it('keeps only remote secrets the deploy neither overwrites nor replaces', () => {
    expect(
      selectInheritedRemoteSecretNames(
        ['AUTH_SECRET', 'CLEARED_SECRET', 'DASHBOARD_ONLY_TOKEN', 'NOW_A_VAR', 'NOW_A_BINDING'],
        // An explicitly empty value is still an overwrite of the remote secret, so it is
        // counted by the payload, not as inherited.
        { AUTH_SECRET: 'auth', CLEARED_SECRET: '' },
        ['NOW_A_VAR', 'NOW_A_BINDING']
      )
    ).toEqual(['DASHBOARD_ONLY_TOKEN']);
  });

  it('correctly handles prototype properties of Object (e.g. toString)', () => {
    expect(selectInheritedRemoteSecretNames(['toString', 'constructor', 'hasOwnProperty', 'valueOf'], {}, [])).toEqual([
      'toString',
      'constructor',
      'hasOwnProperty',
      'valueOf',
    ]);
  });
});

describe('quoteDotenvValue', () => {
  it('produces representations that round-trip under the dotenv parser', () => {
    // No apostrophe: single quotes preserve #, newlines, double quotes, and literal \n.
    for (const value of [
      String.raw`plain\n #hash "double"` + '\nline2',
      "a'b#c", // apostrophe closes a single-quoted span early -> backticks
      "tick`'\nline2", // apostrophe + backtick -> double quotes with escaped newlines
      'tick`\'"\nline2', // embedded double quote in the double-quoted branch
      'a\r\nb', // CR survives only as a double-quoted escape
    ]) {
      expect(roundTripDotenvValue(value)).toBe(value);
    }
    // The parse-verified candidates even cover apostrophe + backtick + literal \n via
    // dotenv's unquoted-line fallback.
    expect(roundTripDotenvValue("a'b`" + String.raw`\n`)).toBe("a'b`" + String.raw`\n`);
    // A # after an embedded double quote starts a comment and dotenv does not unescape
    // inner \", so this combination is genuinely unrepresentable.
    expect(() => quoteDotenvValue('K', 'a\r"#b')).toThrow('losslessly');
  });
});

function roundTripDotenvValue(value: string): string | undefined {
  return parseDotenv(`K=${quoteDotenvValue('K', value)}`).K;
}
