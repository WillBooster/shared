import child_process from 'node:child_process';

import { describe, expect, it } from 'vitest';
import yargs from 'yargs';

import { retryCommand } from '../src/commands/retry.js';
import { buildPlaywrightArgsForE2E, testCommand } from '../src/commands/test.js';

describe('buildPlaywrightArgsForE2E', () => {
  it('uses the default e2e directory when no explicit target is provided', () => {
    expect(buildPlaywrightArgsForE2E([])).toEqual(['test', 'test/e2e/']);
  });

  it('omits explicit e2e targets because they are provided separately to the command builder', () => {
    expect(buildPlaywrightArgsForE2E(['test/e2e/phaserAssetLoading.spec.ts'])).toEqual(['test']);
  });

  it('appends wb-managed mode flags after forwarded playwright flags', () => {
    expect(buildPlaywrightArgsForE2E([], ['--headed'])).toEqual(['test', 'test/e2e/', '--headed']);
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

describe('command-specific -- parsing', () => {
  it('populates argv["--"] for wb test', () => {
    const parser = (
      typeof testCommand.builder === 'function'
        ? testCommand.builder(yargs() as never)
        : yargs().options(testCommand.builder ?? {})
    ) as ReturnType<typeof yargs>;
    const argv = parser.parseSync(['--', '--grep', 'uploaded image asset']) as {
      '--'?: string[];
    };

    expect(argv['--']).toEqual(['--grep', 'uploaded image asset']);
  });

  it('keeps retry arguments in positional argv for wb retry -- ...', () => {
    const parser = (
      typeof retryCommand.builder === 'function'
        ? retryCommand.builder(yargs() as never)
        : yargs().options(retryCommand.builder ?? {})
    ) as ReturnType<typeof yargs>;
    const argv = parser.parseSync(['--', 'docker', 'build', '-t', 'img', '.']) as {
      _: string[];
      '--'?: string[];
    };

    expect(argv._).toEqual(['docker', 'build', '-t', 'img', '.']);
    expect(argv['--']).toBeUndefined();
  });
});
