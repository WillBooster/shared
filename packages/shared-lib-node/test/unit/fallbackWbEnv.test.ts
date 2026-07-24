import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readEnvironmentVariables, resolveFallbackWbEnv } from '../../src/env.js';
import { isFnoxAvailable } from '../helpers/commandAvailability.js';

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

  it.runIf(isFnoxAvailable())('re-expands dependent references when the expansion empties WB_ENV', () => {
    delete process.env.WB_ENV;
    const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-lib-node-wbenv-'));
    try {
      // WB_ENV is EMPTIED by the expansion itself; DEPENDENT must still receive the fallback the
      // completed environment will carry. Bare `$VAR` passes through fnox untouched, so the
      // reader's own dotenv-expand pass performs both expansions.
      fs.writeFileSync(
        path.join(tempDirPath, 'fnox.toml'),
        '[secrets]\nWB_ENV = { default = "$MISSING_MODE" }\nDEPENDENT = { default = "prefix-$WB_ENV" }\n'
      );
      const [envVars] = readEnvironmentVariables({ autoCascadeEnv: false }, tempDirPath, {
        expandFallbackWbEnv: true,
      });
      // The emptied WB_ENV is dropped here — wb's Project.completeAndValidateWbEnv fills it with
      // the same fallback afterwards — while dependent references already use that fallback.
      expect(envVars.WB_ENV).toBeUndefined();
      expect(envVars.DEPENDENT).toBe('prefix-development');
    } finally {
      fs.rmSync(tempDirPath, { recursive: true, force: true });
    }
  });

  it.runIf(isFnoxAvailable())('re-expands with the exported value when a forced mode profile empties WB_ENV', () => {
    // A forced mode's fnox profile overrides the export locally, so the loaded key masks the
    // ambient value even when it expands to empty; CI is cleared because that override is local-only.
    const originalCi = process.env.CI;
    process.env.WB_ENV = 'test';
    delete process.env.CI;
    const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-lib-node-wbenv-'));
    try {
      fs.writeFileSync(
        path.join(tempDirPath, 'fnox.toml'),
        '[secrets]\nBASE_ONLY = { default = "base" }\n\n[profiles.test.secrets]\nWB_ENV = { default = "$MISSING_MODE" }\nDEPENDENT = { default = "prefix-$WB_ENV" }\n'
      );
      const [envVars] = readEnvironmentVariables({ cascadeEnv: 'test' }, tempDirPath, {
        expandFallbackWbEnv: true,
      });
      expect(envVars.WB_ENV).toBeUndefined();
      expect(envVars.DEPENDENT).toBe('prefix-test');
    } finally {
      if (originalCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCi;
      }
      fs.rmSync(tempDirPath, { recursive: true, force: true });
    }
  });
});
