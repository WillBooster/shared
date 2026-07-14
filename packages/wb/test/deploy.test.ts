import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selectInheritedRemoteSecretNames, selectWorkerSecrets } from '../src/commands/deploy.js';
import { parse as parseDotenv } from 'dotenv';

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
      vars: { WB_ENV: 'production', NEXT_PUBLIC_BASE_URL: 'https://example.com' },
      requiredSecretNames: [],
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
      vars: { WB_ENV: 'staging' },
      requiredSecretNames: [],
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
    // same-named staging secret; assets IS inherited and applies to every environment.
    const staging = resolveWranglerConfigForEnv({ dirPath }, 'staging');
    expect(staging?.bindingNames.toSorted()).toEqual(['ASSETS']);
  });

  it('uses the environment-overridden assets binding instead of the top-level one', async () => {
    await fs.writeFile(
      path.join(dirPath, 'wrangler.jsonc'),
      `{
        "name": "my-app",
        "assets": { "directory": "dist/client", "binding": "ASSETS" },
        "env": { "staging": { "assets": { "directory": "dist/client", "binding": "STATIC" } } },
      }`
    );

    // Inheritable fields are overridden as whole fields, so a staging override removes the
    // top-level name from the effective binding set.
    const staging = resolveWranglerConfigForEnv({ dirPath }, 'staging');
    expect(staging?.bindingNames.toSorted()).toEqual(['STATIC']);
  });

  it('keeps top-level record bindings for named environments and does not inherit secrets.required', async () => {
    await fs.writeFile(
      path.join(dirPath, 'wrangler.jsonc'),
      `{
        "name": "my-app",
        "text_blobs": { "MESSAGE": "message.txt" },
        "secrets": { "required": ["TOP_SECRET"] },
        "env": { "staging": {} },
      }`
    );

    const staging = resolveWranglerConfigForEnv({ dirPath }, 'staging');
    expect(staging?.bindingNames.toSorted()).toEqual(['MESSAGE']);
    // secrets is non-inheritable: a top-level requirement must not force (or upload) a
    // secret into a named environment.
    expect(staging?.requiredSecretNames).toEqual([]);
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
      vars: {},
      requiredSecretNames: [],
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
    // An explicit pattern opts in even before the directory exists.
    expect(usesWranglerNativeMigrations({ dirPath }, { migrations_pattern: 'migrations/*/migration.sql' })).toBe(true);

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
          CF_ACCOUNT_ID: 'a',
          CLOUDFLARE_API_KEY: 'k',
          CLOUDFLARE_ACCESS_CLIENT_SECRET: 's',
          CLOUDFLARE_AUTH_USE_KEYRING: 'true',
          CLOUDFLARE_CF_FETCH_CA: 'ca',
          DOCKER_HOST: 'unix:///var/run/docker.sock',
          MINIFLARE_CACHE_DIR: '/tmp/mf',
          HTTPS_PROXY: 'https://user:password@proxy.example',
          http_proxy: 'http://proxy.example',
          CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
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

describe('selectInheritedRemoteSecretNames', () => {
  it('keeps only remote secrets the deploy neither overwrites nor replaces', () => {
    expect(
      selectInheritedRemoteSecretNames(
        ['DASHBOARD_ONLY_TOKEN', 'AUTH_SECRET', 'NOW_A_VAR', 'NOW_A_BINDING', 'CLEARED_SECRET'],
        // An explicitly empty value still overwrites the remote secret (with ''), so it is
        // counted by the payload, not as inherited.
        { AUTH_SECRET: 'auth', CLEARED_SECRET: '' },
        ['NOW_A_VAR'],
        ['NOW_A_BINDING']
      )
    ).toEqual(['DASHBOARD_ONLY_TOKEN']);
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
      // JSON-valued vars and unsafe metadata are data, not bindings.
      vars: { SETTINGS: { binding: 'AUTH_SECRET' } },
      unsafe: { metadata: { custom: { binding: 'OTHER_SECRET' } } },
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

function roundTripDotenvValue(value: string): string | undefined {
  return parseDotenv(`K=${quoteDotenvValue('K', value)}`).K;
}

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
