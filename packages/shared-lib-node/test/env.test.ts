import childProcess from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAndApplyEnvironmentVariables, readEnvironmentVariables } from '../src/env.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.WB_ENV = '';
  process.env.NODE_ENV = '';
  // Clear env vars that could affect env loading behavior in tests.

  delete process.env.PORT;

  delete process.env.NAME;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe('readAndApplyEnvironmentVariables()', () => {
  it('should load no env vars with empty options', () => {
    const envVars = readAndApplyEnvironmentVariables({}, 'test/fixtures/app1');
    expect(withoutPath(envVars)).toEqual({});
  });

  it('should load env vars with --auto-cascade-env', () => {
    const envVars = readAndApplyEnvironmentVariables({ autoCascadeEnv: true }, 'test/fixtures/app1');
    expect(withoutPath(envVars)).toEqual({ ENV: 'development1', PORT: '3001', NAME: 'app1' });
  });

  it('should load env vars with --cascade-env=production', () => {
    const envVars = readAndApplyEnvironmentVariables({ cascadeEnv: 'production', env: ['.env'] }, 'test/fixtures/app1');
    expect(withoutPath(envVars)).toEqual({ ENV: 'production1', PORT: '3003', NAME: 'app1' });
  });

  it('should load env vars with --cascade-node-env and NODE_ENV=""', () => {
    process.env.NODE_ENV = '';
    const envVars = readAndApplyEnvironmentVariables({ cascadeNodeEnv: true, env: ['.env'] }, 'test/fixtures/app1');
    expect(withoutPath(envVars)).toEqual({ ENV: 'development1', PORT: '3001', NAME: 'app1' });
  });

  it('should load env vars with --cascade-node-env and NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    const envVars = readAndApplyEnvironmentVariables({ cascadeNodeEnv: true, env: ['.env'] }, 'test/fixtures/app1');
    expect(withoutPath(envVars)).toEqual({ ENV: 'test1', PORT: '3002', NAME: 'app1' });
  });

  it('should load env vars with --env=test/fixtures/app2/.env --auto-cascade-env, WB_ENV=test and NODE_ENV=production', () => {
    process.env.WB_ENV = 'test';
    process.env.NODE_ENV = 'production';
    const envVars = readAndApplyEnvironmentVariables(
      { autoCascadeEnv: true, env: ['../app2/.env'] },
      'test/fixtures/app1'
    );
    expect(withoutPath(envVars)).toEqual({ ENV: 'test2', PORT: '4002', NAME: 'app2' });
  });

  it('should not overwrite existing process.env values', () => {
    process.env.PORT = '9999';
    process.env.NAME = 'override';
    const envVars = readAndApplyEnvironmentVariables({ autoCascadeEnv: true }, 'test/fixtures/app1');
    expect(withoutPath(envVars)).toEqual({ ENV: 'development1' });
    expect(process.env.ENV).toBe('development1');
    expect(process.env.PORT).toBe('9999');
    expect(process.env.NAME).toBe('override');
  });

  it.runIf(isMiseAvailable())('should load env vars from mise toml with --auto-cascade-env', () => {
    const envVars = readAndApplyEnvironmentVariables({ autoCascadeEnv: true }, 'test/fixtures/app3');
    expect(envVars).toMatchObject({ ENV: 'development3', MISE_ONLY: 'base3', NAME: 'app3', PORT: '5001' });
  });

  it.runIf(isMiseAvailable())('should load env vars from mise environment toml with --cascade-env=test', () => {
    const envVars = readAndApplyEnvironmentVariables({ cascadeEnv: 'test' }, 'test/fixtures/app3');
    expect(envVars).toMatchObject({ ENV: 'test3', MISE_ONLY: 'base3', NAME: 'app3', PORT: '5002' });
  });

  it.runIf(isMiseAvailable())('should not apply mise env vars over existing process.env values', () => {
    process.env.PORT = '9999';
    const envVars = readAndApplyEnvironmentVariables({ cascadeEnv: 'test' }, 'test/fixtures/app3');
    expect(envVars).toMatchObject({ ENV: 'test3', MISE_ONLY: 'base3', NAME: 'app3', PORT: '5002' });
    expect(process.env.PORT).toBe('9999');
  });

  it.runIf(isFnoxAvailable())('should load env vars from fnox.toml preferring .env files', () => {
    const envVars = readAndApplyEnvironmentVariables({ autoCascadeEnv: true }, 'test/fixtures/app-fnox');
    expect(envVars).toMatchObject({
      ENV: 'dotenv-development',
      FNOX_ONLY: 'base-fnox',
      NAME: 'app-fnox',
      PORT: '6001',
      // .env values referencing fnox-provided keys must resolve across sources.
      REF: 'ref-base-fnox',
    });
  });

  it.runIf(isFnoxAvailable())('should not overwrite existing process.env values with fnox values', () => {
    process.env.PORT = '9999';
    const envVars = readAndApplyEnvironmentVariables({ autoCascadeEnv: true }, 'test/fixtures/app-fnox');
    expect(envVars.PORT).toBeUndefined();
    expect(process.env.PORT).toBe('9999');
  });

  it.runIf(isFnoxAvailable())('should load env vars from a fnox profile with --cascade-env=test', () => {
    const envVars = readAndApplyEnvironmentVariables({ cascadeEnv: 'test' }, 'test/fixtures/app-fnox');
    expect(envVars).toMatchObject({
      ENV: 'dotenv-development',
      FNOX_ONLY: 'base-fnox',
      NAME: 'app-fnox',
      PORT: '6002',
      REF: 'ref-base-fnox',
    });
  });
});

describe('readEnvironmentVariables()', () => {
  it('should skip existing process.env values in env vars and env files list', () => {
    process.env.PORT = '9999';
    process.env.NAME = 'override';
    const [envVars, envPathAndLoadedEnvVarNames] = readEnvironmentVariables(
      { autoCascadeEnv: true },
      'test/fixtures/app1'
    );
    expect(withoutPath(envVars)).toEqual({ ENV: 'development1' });
    expect(envPathAndLoadedEnvVarNames.filter(([source]) => !source.startsWith('mise env'))).toEqual([
      ['.env.development', ['ENV']],
      ['.env', []],
    ]);
    expect(process.env.PORT).toBe('9999');
    expect(process.env.NAME).toBe('override');
  });

  it('should let mode-specific env file values override inherited process.env when the mode is forced (non-CI)', () => {
    delete process.env.CI;
    process.env.WB_ENV = 'test';
    process.env.PORT = '9999';
    const [envVars] = readEnvironmentVariables({ autoCascadeEnv: true }, 'test/fixtures/app1');
    // .env.test defines PORT=3002; the forced test mode must win over the inherited shell value.
    expect(envVars.PORT).toBe('3002');
    expect(envVars.ENV).toBe('test1');
  });

  it('should keep inherited process.env values on CI even when the mode is forced', () => {
    process.env.CI = 'true';
    process.env.WB_ENV = 'test';
    process.env.PORT = '9999';
    const [envVars] = readEnvironmentVariables({ autoCascadeEnv: true }, 'test/fixtures/app1');
    expect(envVars.PORT).toBeUndefined();
    expect(process.env.PORT).toBe('9999');
  });

  it('should not override inherited process.env values that only the base .env defines even when the mode is forced', () => {
    delete process.env.CI;
    process.env.WB_ENV = 'test';
    process.env.NAME = 'override';
    const [envVars] = readEnvironmentVariables({ autoCascadeEnv: true }, 'test/fixtures/app1');
    expect(envVars.NAME).toBeUndefined();
    expect(process.env.NAME).toBe('override');
  });

  it('should expand references to exported variables literally', () => {
    // Values referencing exported keys must resolve to the effective value without the
    // exported content being recursively re-expanded (pa$word must stay pa$word).
    process.env.EXPORTED_SECRET = 'pa$word';
    process.env.API_HOST = 'prod.example';
    const [envVars] = readEnvironmentVariables({ autoCascadeEnv: true }, 'test/fixtures/app-expand');
    expect(withoutPath(envVars)).toEqual({ WORKER_SECRET: 'pa$word', CALLBACK_URL: 'https://prod.example/cb' });
  });
});

function isMiseAvailable(): boolean {
  return childProcess.spawnSync('mise', ['--version'], { stdio: 'ignore' }).status === 0;
}

function isFnoxAvailable(): boolean {
  return childProcess.spawnSync('fnox', ['--version'], { stdio: 'ignore' }).status === 0;
}

function withoutPath(envVars: Record<string, string | undefined>): Record<string, string | undefined> {
  // The repository root now contains mise.toml, so `mise env` contributes PATH to every fixture.
  const { PATH: _, ...rest } = envVars;
  return rest;
}
