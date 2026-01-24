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
    expect(envVars).toEqual({});
  });

  it('should load env vars with --auto-cascade-env', () => {
    const envVars = readAndApplyEnvironmentVariables({ autoCascadeEnv: true }, 'test/fixtures/app1');
    expect(envVars).toEqual({ ENV: 'development1', PORT: '3001', NAME: 'app1' });
  });

  it('should load env vars with --cascade-env=production', () => {
    const envVars = readAndApplyEnvironmentVariables({ cascadeEnv: 'production', env: ['.env'] }, 'test/fixtures/app1');
    expect(envVars).toEqual({ ENV: 'production1', PORT: '3003', NAME: 'app1' });
  });

  it('should load env vars with --cascade-node-env and NODE_ENV=""', () => {
    process.env.NODE_ENV = '';
    const envVars = readAndApplyEnvironmentVariables({ cascadeNodeEnv: true, env: ['.env'] }, 'test/fixtures/app1');
    expect(envVars).toEqual({ ENV: 'development1', PORT: '3001', NAME: 'app1' });
  });

  it('should load env vars with --cascade-node-env and NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    const envVars = readAndApplyEnvironmentVariables({ cascadeNodeEnv: true, env: ['.env'] }, 'test/fixtures/app1');
    expect(envVars).toEqual({ ENV: 'test1', PORT: '3002', NAME: 'app1' });
  });

  it('should load env vars with --env=test/fixtures/app2/.env --auto-cascade-env, WB_ENV=test and NODE_ENV=production', () => {
    process.env.WB_ENV = 'test';
    process.env.NODE_ENV = 'production';
    const envVars = readAndApplyEnvironmentVariables(
      { autoCascadeEnv: true, env: ['../app2/.env'] },
      'test/fixtures/app1'
    );
    expect(envVars).toEqual({ ENV: 'test2', PORT: '4002', NAME: 'app2' });
  });

  it('should not overwrite existing process.env values', () => {
    process.env.PORT = '9999';
    process.env.NAME = 'override';
    const envVars = readAndApplyEnvironmentVariables({ autoCascadeEnv: true }, 'test/fixtures/app1');
    expect(envVars).toEqual({ ENV: 'development1' });
    expect(process.env.ENV).toBe('development1');
    expect(process.env.PORT).toBe('9999');
    expect(process.env.NAME).toBe('override');
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
    expect(envVars).toEqual({ ENV: 'development1' });
    expect(envPathAndLoadedEnvVarNames).toEqual([
      ['.env.development', ['ENV']],
      ['.env', []],
    ]);
    expect(process.env.PORT).toBe('9999');
    expect(process.env.NAME).toBe('override');
  });
});
