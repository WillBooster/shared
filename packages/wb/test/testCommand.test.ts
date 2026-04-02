import child_process from 'node:child_process';

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

describe('wb test --help', () => {
  it('explains that -- forwards the remaining flags to Playwright', () => {
    const result = child_process.spawnSync('yarn', ['workspace', '@willbooster/wb', 'start', 'test', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const normalizedStdout = result.stdout.replaceAll(/\s+/g, ' ');

    expect(result.status).toBe(0);
    expect(normalizedStdout).toContain(`Use '--' to stop wb option parsing`);
    expect(normalizedStdout).toContain(`forward the remaining flags to Playwright.`);
    expect(normalizedStdout).toContain(`Example: wb test -- --grep`);
    expect(normalizedStdout).toContain(`'uploaded image asset'`);
  });
});
