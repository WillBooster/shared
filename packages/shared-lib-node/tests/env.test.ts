import { beforeEach, describe, expect, it } from 'vitest';

import { loadEnvironmentVariables } from '../src/env.js';

describe('loadEnvironmentVariables()', () => {
  beforeEach(() => {
    process.env.WB_ENV = '';
    process.env.NODE_ENV = '';
  });

  it('should load no env vars with empty options', () => {
    const envVars = loadEnvironmentVariables({}, 'test-fixtures/app');
    expect(envVars).toEqual({});
  });

  it('should load env vars with --auto-cascade-env', () => {
    const envVars = loadEnvironmentVariables({ autoCascadeEnv: true }, 'test-fixtures/app');
    expect(envVars).toEqual({ NAME: 'app1', ENV: 'development1' });
  });

  it('should load env vars with --cascade-env=production', () => {
    const envVars = loadEnvironmentVariables({ cascadeEnv: 'production', env: ['.env'] }, 'test-fixtures/app');
    expect(envVars).toEqual({ NAME: 'app1', ENV: 'production1' });
  });

  it('should load env vars with --cascade-node-env and NODE_ENV=""', () => {
    process.env.NODE_ENV = '';
    const envVars = loadEnvironmentVariables({ cascadeNodeEnv: true, env: ['.env'] }, 'test-fixtures/app');
    expect(envVars).toEqual({ NAME: 'app1', ENV: 'development1' });
  });

  it('should load env vars with --cascade-node-env and NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    const envVars = loadEnvironmentVariables({ cascadeNodeEnv: true, env: ['.env'] }, 'test-fixtures/app');
    expect(envVars).toEqual({ NAME: 'app1', ENV: 'test1' });
  });

  it('should load env vars with --env=test-fixtures/another-app/.env --auto-cascade-env, WB_ENV=test and NODE_ENV=production', () => {
    process.env.WB_ENV = 'test';
    process.env.NODE_ENV = 'production';
    const envVars = loadEnvironmentVariables(
      { autoCascadeEnv: true, env: ['.env'] },
      'test-fixtures/app',
      'test-fixtures/another-app'
    );
    expect(envVars).toEqual({ NAME: 'app2', ENV: 'test2' });
  });
});
