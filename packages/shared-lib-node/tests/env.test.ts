import { beforeEach, describe, expect, it } from 'vitest';

import { readAndUpdateEnvironmentVariables } from '../src/env.js';

describe('readAndApplyEnvironmentVariables()', () => {
  beforeEach(() => {
    process.env.WB_ENV = '';
    process.env.NODE_ENV = '';
  });

  it('should load no env vars with empty options', () => {
    const envVars = readAndUpdateEnvironmentVariables({}, 'test-fixtures/app1');
    expect(envVars).toEqual({});
  });

  it('should load env vars with --auto-cascade-env', () => {
    const envVars = readAndUpdateEnvironmentVariables({ autoCascadeEnv: true }, 'test-fixtures/app1');
    expect(envVars).toEqual({ NAME: 'app1', ENV: 'development1' });
  });

  it('should load env vars with --cascade-env=production', () => {
    const envVars = readAndUpdateEnvironmentVariables(
      { cascadeEnv: 'production', env: ['.env'] },
      'test-fixtures/app1'
    );
    expect(envVars).toEqual({ NAME: 'app1', ENV: 'production1' });
  });

  it('should load env vars with --cascade-node-env and NODE_ENV=""', () => {
    process.env.NODE_ENV = '';
    const envVars = readAndUpdateEnvironmentVariables({ cascadeNodeEnv: true, env: ['.env'] }, 'test-fixtures/app1');
    expect(envVars).toEqual({ NAME: 'app1', ENV: 'development1' });
  });

  it('should load env vars with --cascade-node-env and NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    const envVars = readAndUpdateEnvironmentVariables({ cascadeNodeEnv: true, env: ['.env'] }, 'test-fixtures/app1');
    expect(envVars).toEqual({ NAME: 'app1', ENV: 'test1' });
  });

  it('should load env vars with --env=test-fixtures/app2/.env --auto-cascade-env, WB_ENV=test and NODE_ENV=production', () => {
    process.env.WB_ENV = 'test';
    process.env.NODE_ENV = 'production';
    const envVars = readAndUpdateEnvironmentVariables(
      { autoCascadeEnv: true, env: ['../app2/.env'] },
      'test-fixtures/app1'
    );
    expect(envVars).toEqual({ NAME: 'app2', ENV: 'test2' });
  });
});
