import { describe, expect, it } from 'vitest';

import { buildPlaywrightArgsForE2E } from '../src/commands/test.js';

describe('buildPlaywrightArgsForE2E', () => {
  it('uses the default e2e directory when no explicit target is provided', () => {
    expect(buildPlaywrightArgsForE2E([], {})).toEqual(['test', 'test/e2e/']);
  });

  it('keeps explicit e2e targets before forwarded playwright flags', () => {
    expect(
      buildPlaywrightArgsForE2E(['test/e2e/phaserAssetLoading.spec.ts'], {
        '--': ['--grep', 'uploaded image asset', '--project', 'chromium'],
      })
    ).toEqual([
      'test',
      'test/e2e/phaserAssetLoading.spec.ts',
      '--grep',
      'uploaded image asset',
      '--project',
      'chromium',
    ]);
  });

  it('appends wb-managed mode flags after forwarded playwright flags', () => {
    expect(buildPlaywrightArgsForE2E([], { '--': ['--grep', 'uploaded'] }, ['--headed'])).toEqual([
      'test',
      'test/e2e/',
      '--grep',
      'uploaded',
      '--headed',
    ]);
  });
});
