import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selectWorkerSecrets } from '../src/commands/deploy.js';
import { quoteDotenvValue } from '../src/commands/genDevVars.js';
import {
  collectBindingNames,
  resolveWranglerConfigForEnv,
  usesWranglerNativeMigrations,
} from '../src/utils/wranglerConfig.js';

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
      bindingNames: ['DB'],
      d1Databases: [{ binding: 'DB', database_name: 'my-app-production', database_id: 'prod-id' }],
      usesEnvSection: false,
    });

    // account_id is inherited by named environments; vars and d1_databases are not.
    const staging = resolveWranglerConfigForEnv({ dirPath }, 'staging');
    expect(staging).toEqual({
      workerName: 'my-app-staging',
      accountId: 'acc-1',
      varKeys: ['WB_ENV'],
      bindingNames: ['DB'],
      d1Databases: [
        { binding: 'DB', database_name: 'my-app-staging', database_id: 'stg-id', migrations_dir: 'drizzle' },
      ],
      usesEnvSection: true,
    });
  });

  it('counts only inherited top-level binding shapes for named environments', async () => {
    await fs.writeFile(
      path.join(dirPath, 'wrangler.jsonc'),
      `{
        "name": "my-app",
        "assets": { "directory": "dist/client", "binding": "ASSETS" },
        "d1_databases": [{ "binding": "API_TOKEN", "database_id": "prod-id" }],
        "env": { "staging": {} },
      }`
    );

    // D1/KV/... are non-inheritable, so a top-level binding name must not suppress a
    // same-named staging secret; assets IS top-level-only and applies to every environment.
    const staging = resolveWranglerConfigForEnv({ dirPath }, 'staging');
    expect(staging?.bindingNames.toSorted()).toEqual(['ASSETS']);
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
      bindingNames: ['DB'],
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

describe('usesWranglerNativeMigrations', () => {
  let dirPath: string;

  beforeEach(async () => {
    dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-deploy-test-'));
  });

  afterEach(async () => {
    await fs.rm(dirPath, { force: true, recursive: true });
  });

  it('requires flat *.sql files or an explicit migrations_pattern', async () => {
    expect(usesWranglerNativeMigrations({ dirPath }, {})).toBe(false);

    // drizzle-kit's nested layout without a migrations_pattern matches nothing for wrangler,
    // so it must fall through to the drizzle-kit mechanism.
    await fs.mkdir(path.join(dirPath, 'migrations', '0001_init'), { recursive: true });
    await fs.writeFile(path.join(dirPath, 'migrations', '0001_init', 'migration.sql'), 'CREATE TABLE t (id);');
    expect(usesWranglerNativeMigrations({ dirPath }, {})).toBe(false);
    expect(usesWranglerNativeMigrations({ dirPath }, { migrations_pattern: 'migrations/*/migration.sql' })).toBe(true);

    await fs.writeFile(path.join(dirPath, 'migrations', '0001_init.sql'), 'CREATE TABLE t (id);');
    expect(usesWranglerNativeMigrations({ dirPath }, {})).toBe(true);
    expect(usesWranglerNativeMigrations({ dirPath }, { migrations_dir: 'drizzle' })).toBe(false);
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
    // Wrangler system/authentication variables never become Worker secrets.
    expect(
      selectWorkerSecrets(
        {
          CLOUDFLARE_API_KEY: 'k',
          CLOUDFLARE_ACCESS_CLIENT_SECRET: 's',
          WRANGLER_R2_SQL_AUTH_TOKEN: 't',
          CLOUDFLARE_R2_ACCESS_KEY_ID: 'app-key',
        },
        [],
        []
      ).secrets
    ).toEqual({ CLOUDFLARE_R2_ACCESS_KEY_ID: 'app-key' });
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

describe('collectBindingNames', () => {
  it('collects binding properties and name-keyed bindings, skipping env subtrees', () => {
    const names = collectBindingNames({
      name: 'my-app',
      assets: { directory: 'dist/client', binding: 'ASSETS' },
      kv_namespaces: [{ binding: 'VINEXT_KV_CACHE', id: 'kv-id' }],
      d1_databases: [{ binding: 'DB', database_name: 'db' }],
      durable_objects: { bindings: [{ name: 'BOARD_GAME_ROOM', class_name: 'BoardGameRoom' }] },
      send_email: [{ name: 'EMAIL' }],
      ratelimits: [{ name: 'LIMITER', namespace_id: '1', simple: { limit: 1, period: 60 } }],
      text_blobs: { MESSAGE: 'message.txt' },
      env: { staging: { kv_namespaces: [{ binding: 'STAGING_ONLY' }] } },
    });
    expect([...names].toSorted()).toEqual([
      'ASSETS',
      'BOARD_GAME_ROOM',
      'DB',
      'EMAIL',
      'LIMITER',
      'MESSAGE',
      'VINEXT_KV_CACHE',
    ]);
  });
});

describe('quoteDotenvValue', () => {
  it('round-trips via single quotes, backticks, or double quotes, and rejects unrepresentable values', () => {
    // No apostrophe: single quotes preserve #, newlines, double quotes, and literal \n.
    expect(quoteDotenvValue('K', String.raw`plain\n #hash "double"` + '\nline2')).toBe(
      `'${String.raw`plain\n #hash "double"` + '\nline2'}'`
    );
    // Apostrophe (which closes a single-quoted span early, e.g. before a # comment): backticks.
    expect(quoteDotenvValue('K', "a'b#c")).toBe("`a'b#c`");
    // Apostrophe + backtick: double quotes with escaped newlines.
    expect(quoteDotenvValue('K', "tick`'\nline2")).toBe(String.raw`"tick` + '`' + String.raw`'\nline2"`);
    // Unrepresentable: apostrophe + backtick + double quote, or any carriage return.
    expect(() => quoteDotenvValue('K', 'tick`\'"\nline2')).toThrow('losslessly');
    expect(() => quoteDotenvValue('K', 'a\r\nb')).toThrow('carriage return');
  });
});
