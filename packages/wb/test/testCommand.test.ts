import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import yargs from 'yargs';

import { retryCommand } from '../src/commands/retry.js';
import {
  buildPlaywrightArgsForE2E,
  getDefaultUnitTargets,
  resolveTestExecutionTargets,
  testCommand,
  type TestCommandArgv,
  withDefaultTestCascadeEnv,
} from '../src/commands/test.js';

describe('buildPlaywrightArgsForE2E', () => {
  it('uses the default e2e directory when no explicit target is provided', () => {
    expect(buildPlaywrightArgsForE2E([])).toEqual(['test', 'test/e2e/']);
  });

  it('omits explicit e2e targets because they are provided separately to the command builder', () => {
    expect(buildPlaywrightArgsForE2E(['test/e2e/phaserAssetLoading.spec.ts'])).toEqual(['test']);
  });

  it('appends wb-managed mode flags after forwarded playwright flags', () => {
    expect(buildPlaywrightArgsForE2E([], [], ['--headed'])).toEqual(['test', 'test/e2e/', '--headed']);
  });

  it('skips the default e2e directory when forwarded args already include explicit playwright targets', () => {
    expect(buildPlaywrightArgsForE2E([], ['test/e2e/phaserAssetLoading.spec.ts'])).toEqual(['test']);
  });
});

describe('wb test --help', () => {
  it('explains that -- forwards the remaining flags to Playwright', () => {
    const result = child_process.spawnSync('bun', ['run', 'start', 'test', '--help'], {
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

describe('resolveTestExecutionTargets', () => {
  it('runs only e2e tests when playwright args are forwarded without positional targets', () => {
    expect(resolveTestExecutionTargets([], ['--grep', 'uploaded image asset'])).toEqual({
      shouldRunUnit: false,
      shouldRunE2e: true,
    });
  });

  it('still runs unit tests when unit targets are explicitly requested', () => {
    expect(resolveTestExecutionTargets(['test/unit/example.test.ts'], ['--grep', 'uploaded image asset'])).toEqual({
      shouldRunUnit: true,
      shouldRunE2e: true,
    });
  });

  // Unit tests may live directly under `test/`, so such a target must not be silently dropped.
  it('runs unit tests when a target directly under test/ is requested', () => {
    expect(resolveTestExecutionTargets(['test/example.test.ts'])).toEqual({
      shouldRunUnit: true,
      shouldRunE2e: false,
    });
  });
});

describe('getDefaultUnitTargets', () => {
  const dirPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(dirPaths.splice(0).map((dirPath) => fs.rm(dirPath, { force: true, recursive: true })));
  });

  async function createProjectDir(subDirNames: string[]): Promise<string> {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-unit-targets-'));
    dirPaths.push(dirPath);
    for (const subDirName of subDirNames) {
      await fs.mkdir(path.join(dirPath, subDirName), { recursive: true });
    }
    return dirPath;
  }

  // The regression this guards: creating `test/unit` used to switch the target to `test/unit/`
  // exclusively, so the sibling tests directly under `test/` stopped running without any output.
  it('covers both test/ and test/unit/ for a vitest project', async () => {
    const dirPath = await createProjectDir(['test/unit']);
    expect(getDefaultUnitTargets({ dirPath, hasVitest: true })).toEqual(['./test/']);
  });

  it('excludes e2e specs for a vitest project', async () => {
    const dirPath = await createProjectDir(['test/unit', 'test/e2e']);
    expect(getDefaultUnitTargets({ dirPath, hasVitest: true })).toEqual(['./test/', '--exclude', 'test/e2e/**']);
  });

  it('covers the whole test directory for a non-vitest project without e2e specs', async () => {
    const dirPath = await createProjectDir(['test']);
    expect(getDefaultUnitTargets({ dirPath, hasVitest: false })).toEqual(['./test/']);
  });

  it('falls back to test/unit/ for a non-vitest project having e2e specs', async () => {
    const dirPath = await createProjectDir(['test/unit', 'test/e2e']);
    expect(getDefaultUnitTargets({ dirPath, hasVitest: false })).toEqual(['./test/unit/']);
  });

  it('runs nothing for a non-vitest project having e2e specs but no test/unit', async () => {
    const dirPath = await createProjectDir(['test/e2e']);
    expect(getDefaultUnitTargets({ dirPath, hasVitest: false })).toBe(false);
  });

  it('runs nothing without a test directory', async () => {
    const dirPath = await createProjectDir([]);
    expect(getDefaultUnitTargets({ dirPath, hasVitest: true })).toBe(false);
  });
});

describe('withDefaultTestCascadeEnv', () => {
  it('uses test cascade by default', () => {
    expect(withDefaultTestCascadeEnv({} as TestCommandArgv)).toMatchObject({
      cascadeEnv: 'test',
    });
  });

  // Explicit env flags keep their file/cascade selection, but the command-level WB_ENV default
  // must still make the spawned tests run as `test` when nothing defines WB_ENV.
  it('keeps explicit cascade env and adds the command default', () => {
    expect(withDefaultTestCascadeEnv({ cascadeEnv: 'staging' } as TestCommandArgv)).toEqual({
      cascadeEnv: 'staging',
      commandDefaultWbEnv: 'test',
    });
  });

  it('keeps explicit env files and adds the command default', () => {
    expect(withDefaultTestCascadeEnv({ env: ['.env.custom'] } as unknown as TestCommandArgv)).toEqual({
      env: ['.env.custom'],
      commandDefaultWbEnv: 'test',
    });
  });

  it('keeps disabled auto cascade env and adds the command default', () => {
    expect(withDefaultTestCascadeEnv({ autoCascadeEnv: false } as TestCommandArgv)).toEqual({
      autoCascadeEnv: false,
      commandDefaultWbEnv: 'test',
    });
  });
});
