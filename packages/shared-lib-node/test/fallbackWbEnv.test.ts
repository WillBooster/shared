import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readEnvironmentVariables, resolveFallbackWbEnv } from '../src/env.js';

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

describe('readEnvironmentVariables with expandFallbackWbEnv', () => {
  const originalWbEnv = process.env.WB_ENV;

  afterEach(() => {
    if (originalWbEnv === undefined) {
      delete process.env.WB_ENV;
    } else {
      process.env.WB_ENV = originalWbEnv;
    }
  });

  it('re-expands dependent references when the expansion empties WB_ENV', () => {
    delete process.env.WB_ENV;
    const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-lib-node-wbenv-'));
    try {
      // WB_ENV is EMPTIED by the expansion itself; DEPENDENT must still receive the fallback the
      // completed environment will carry.
      fs.writeFileSync(
        path.join(tempDirPath, '.env'),
        'WB_ENV=${MISSING_MODE}\nDEPENDENT=prefix-${WB_ENV}\n' // eslint-disable-line no-template-curly-in-string
      );
      const [envVars] = readEnvironmentVariables(
        { env: ['.env'], autoCascadeEnv: false, includeRootEnv: false },
        tempDirPath,
        { expandFallbackWbEnv: true }
      );
      // The emptied WB_ENV is dropped here — wb's Project.completeAndValidateWbEnv fills it with
      // the same fallback afterwards — while dependent references already use that fallback.
      expect(envVars.WB_ENV).toBeUndefined();
      expect(envVars.DEPENDENT).toBe('prefix-development');
    } finally {
      fs.rmSync(tempDirPath, { recursive: true, force: true });
    }
  });
});
