import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selectWorkerSecrets } from '../src/commands/deploy.js';
import { resolveWranglerConfigForEnv } from '../src/utils/wranglerConfig.js';

describe('resolveWranglerConfigForEnv', () => {
  let dirPath: string;

  beforeEach(async () => {
    dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-deploy-test-'));
  });

  afterEach(async () => {
    await fs.rm(dirPath, { force: true, recursive: true });
  });

  it('reads the top-level config for production and the env section for staging', async () => {
    await fs.writeFile(
      path.join(dirPath, 'wrangler.jsonc'),
      `{
        // JSONC comments and trailing commas must parse.
        "name": "my-app",
        "account_id": "acc-1",
        "vars": { "WB_ENV": "production", "NEXT_PUBLIC_BASE_URL": "https://example.com" },
        "d1_databases": [{ "binding": "DB", "database_name": "my-app-production", "database_id": "prod-id" }],
        "env": {
          "staging": {
            "vars": { "WB_ENV": "staging" },
            "d1_databases": [
              { "binding": "DB", "database_name": "my-app-staging", "database_id": "stg-id", "migrations_dir": "drizzle" },
            ],
          },
        },
      }`
    );

    const production = resolveWranglerConfigForEnv({ dirPath }, 'production');
    expect(production).toEqual({
      workerName: 'my-app',
      accountId: 'acc-1',
      varKeys: ['WB_ENV', 'NEXT_PUBLIC_BASE_URL'],
      d1Databases: [{ binding: 'DB', database_name: 'my-app-production', database_id: 'prod-id' }],
      usesEnvSection: false,
    });

    // account_id is inherited by named environments; vars and d1_databases are not.
    const staging = resolveWranglerConfigForEnv({ dirPath }, 'staging');
    expect(staging).toEqual({
      workerName: 'my-app-staging',
      accountId: 'acc-1',
      varKeys: ['WB_ENV'],
      d1Databases: [
        { binding: 'DB', database_name: 'my-app-staging', database_id: 'stg-id', migrations_dir: 'drizzle' },
      ],
      usesEnvSection: true,
    });
  });

  it('prefers a named env.production section over the top level', async () => {
    await fs.writeFile(
      path.join(dirPath, 'wrangler.jsonc'),
      `{
        "name": "my-app",
        "d1_databases": [{ "binding": "DB", "database_id": "staging-id" }],
        "env": {
          "production": {
            "name": "my-app-production",
            "d1_databases": [{ "binding": "DB", "database_id": "prod-id" }],
          },
        },
      }`
    );

    const production = resolveWranglerConfigForEnv({ dirPath }, 'production');
    expect(production).toEqual({
      workerName: 'my-app-production',
      accountId: undefined,
      varKeys: [],
      d1Databases: [{ binding: 'DB', database_id: 'prod-id' }],
      usesEnvSection: true,
    });
  });

  it('throws for a missing env section, malformed JSONC, and TOML configs', async () => {
    await fs.writeFile(path.join(dirPath, 'wrangler.jsonc'), '{ "name": "my-app" }');
    expect(() => resolveWranglerConfigForEnv({ dirPath }, 'staging')).toThrow('no "env"');

    // jsonc-parser is fault tolerant, but a partial config must never drive a deploy.
    await fs.writeFile(path.join(dirPath, 'wrangler.jsonc'), '{ "name": "my-app", BROKEN }');
    expect(() => resolveWranglerConfigForEnv({ dirPath }, 'production')).toThrow('syntax error');

    await fs.rm(path.join(dirPath, 'wrangler.jsonc'));
    await fs.writeFile(path.join(dirPath, 'wrangler.toml'), 'name = "my-app"');
    expect(() => resolveWranglerConfigForEnv({ dirPath }, 'production')).toThrow('wrangler.toml');
  });
});

describe('selectWorkerSecrets', () => {
  it('excludes wrangler vars, deploy-control keys, and file: DATABASE_URL, but keeps empty values', () => {
    const { missingKeys, secrets } = selectWorkerSecrets(
      {
        AUTH_SECRET: 'auth',
        NEXT_PUBLIC_BASE_URL: 'https://example.com',
        WB_ENV: 'production',
        CLOUDFLARE_API_TOKEN: 'token',
        DATABASE_URL: 'file:./db/dev.sqlite3',
        // Explicitly empty values are pushed as '' to clear stale remote secrets, because
        // wrangler's --secrets-file is additive and omitted keys keep their old values.
        OPTIONAL_FEATURE_TOKEN: '',
        PORT: '8080',
      },
      ['NEXT_PUBLIC_BASE_URL'],
      []
    );
    expect(secrets).toEqual({ AUTH_SECRET: 'auth', OPTIONAL_FEATURE_TOKEN: '' });
    expect(missingKeys).toEqual([]);
  });

  it('keeps a non-file DATABASE_URL and reports missing required keys', () => {
    const { missingKeys, secrets } = selectWorkerSecrets(
      { DATABASE_URL: 'postgres://db.example.com/app', AUTH_SECRET: '' },
      [],
      ['DATABASE_URL', 'AUTH_SECRET', 'PORT']
    );
    expect(secrets).toEqual({ DATABASE_URL: 'postgres://db.example.com/app', AUTH_SECRET: '' });
    // PORT is a local-only key, so it is not required even when .env.example lists it;
    // a required key that resolves to empty is reported as missing.
    expect(missingKeys).toEqual(['AUTH_SECRET']);
  });
});
