import { afterEach, describe, expect, it } from 'vitest';

import { resolveFallbackWbEnv } from '../src/env.js';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe('resolveFallbackWbEnv', () => {
  it('prefers the command default over the forced cascade (wb test --cascade-env=staging runs as test)', () => {
    expect(resolveFallbackWbEnv({ commandDefaultWbEnv: 'test', cascadeEnv: 'staging' })).toBe('test');
  });

  it('uses the forced cascade when no command default exists', () => {
    expect(resolveFallbackWbEnv({ cascadeEnv: 'staging' })).toBe('staging');
  });

  it('derives from a standard ambient NODE_ENV', () => {
    process.env.NODE_ENV = 'production';
    expect(resolveFallbackWbEnv({})).toBe('production');
  });

  it('clamps a non-standard ambient NODE_ENV to development', () => {
    process.env.NODE_ENV = 'qa';
    expect(resolveFallbackWbEnv({})).toBe('development');
  });
});
