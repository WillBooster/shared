import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import yargs from 'yargs';

import { retryCommand } from '../../src/commands/retry.js';
import {
  buildPlaywrightArgsForE2E,
  findTestStructureViolations,
  getDefaultUnitTargets,
  resolveTestExecutionTargets,
  testCommand,
  type TestCommandArgv,
  withDefaultTestCascadeEnv,
} from '../../src/commands/test.js';

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

  // test/debug/ never runs by default, so an explicit debug target must reach the unit-test runner.
  it('runs the unit-test runner when a debug target is requested', () => {
    expect(resolveTestExecutionTargets(['test/debug/example.test.ts'])).toEqual({
      shouldRunUnit: true,
      shouldRunE2e: false,
    });
  });

  // The e2e classification must match the test/e2e path segment, not the '/e2e' substring.
  it('treats a unit target whose file name starts with e2e as a unit target', () => {
    expect(resolveTestExecutionTargets(['test/unit/e2eConfig.test.ts'])).toEqual({
      shouldRunUnit: true,
      shouldRunE2e: false,
    });
    expect(resolveTestExecutionTargets(['test/e2e/example.spec.ts'])).toEqual({
      shouldRunUnit: false,
      shouldRunE2e: true,
    });
  });
});

const dirPaths: string[] = [];

afterEach(async () => {
  await Promise.all(dirPaths.splice(0).map((dirPath) => fs.rm(dirPath, { force: true, recursive: true })));
});

async function createProjectDir(subDirNames: string[], fileNames: string[] = []): Promise<string> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-test-layout-'));
  dirPaths.push(dirPath);
  for (const subDirName of subDirNames) {
    await fs.mkdir(path.join(dirPath, subDirName), { recursive: true });
  }
  for (const fileName of fileNames) {
    await fs.mkdir(path.dirname(path.join(dirPath, fileName)), { recursive: true });
    await fs.writeFile(path.join(dirPath, fileName), '');
  }
  return dirPath;
}

describe('getDefaultUnitTargets', () => {
  it('targets test/unit/ when it exists', async () => {
    const dirPath = await createProjectDir(['test/unit']);
    expect(getDefaultUnitTargets({ dirPath })).toEqual(['./test/unit/']);
  });

  it('runs nothing without test/unit', async () => {
    const dirPath = await createProjectDir(['test/e2e']);
    expect(getDefaultUnitTargets({ dirPath })).toBe(false);
  });
});

describe('findTestStructureViolations', () => {
  const packageJson = {};

  it('accepts the canonical layout', async () => {
    const dirPath = await createProjectDir(
      ['test/e2e', 'test/debug', 'test/fixtures'],
      ['test/unit/example.test.ts', 'test/helpers/shared.ts', 'src/index.ts']
    );
    expect(findTestStructureViolations({ dirPath, packageJson })).toEqual([]);
  });

  it('accepts a project without a test directory', async () => {
    const dirPath = await createProjectDir([]);
    expect(findTestStructureViolations({ dirPath, packageJson })).toEqual([]);
  });

  // The regression this convention removes: files directly under test/ were silently never run.
  it('rejects files directly under test/ and unknown directories', async () => {
    const dirPath = await createProjectDir(['test/integration'], ['test/example.test.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson }).toSorted()).toEqual([
      'test/example.test.ts',
      'test/integration',
    ]);
  });

  it('rejects test files under test/helpers/ and src/', async () => {
    const dirPath = await createProjectDir([], ['test/helpers/nested/a.test.ts', 'src/nested/b.spec.tsx']);
    expect(findTestStructureViolations({ dirPath, packageJson }).toSorted()).toEqual([
      'src/nested/b.spec.tsx',
      'test/helpers/nested/a.test.ts',
    ]);
  });

  it('allows test files inside test/fixtures/', async () => {
    const dirPath = await createProjectDir([], ['test/fixtures/app/test/unit/example.test.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson })).toEqual([]);
  });

  it('ignores hidden entries such as .DS_Store', async () => {
    const dirPath = await createProjectDir([], ['test/.DS_Store', 'test/unit/example.test.ts', '.tmp/a.test.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson })).toEqual([]);
  });

  it('rejects test files outside test/ such as the project root and scripts/', async () => {
    const dirPath = await createProjectDir([], ['outside.test.ts', 'scripts/deploy.spec.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson }).toSorted()).toEqual([
      'outside.test.ts',
      'scripts/deploy.spec.ts',
    ]);
  });

  it('skips nested packages, which are validated as their own projects', async () => {
    const dirPath = await createProjectDir([], ['packages/app/package.json', 'packages/app/stray.test.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson })).toEqual([]);
  });

  it('rejects a Playwright config without test/e2e except on a workspace root', async () => {
    const dirPath = await createProjectDir(['test/unit'], ['playwright.config.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson })).toEqual(['playwright.config.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson: { workspaces: ['packages/*'] } })).toEqual([]);
  });
});

describe('withDefaultTestCascadeEnv', () => {
  it('uses test cascade by default', () => {
    expect(withDefaultTestCascadeEnv({} as TestCommandArgv)).toMatchObject({
      cascadeEnv: 'test',
    });
  });

  // Explicit env flags keep their cascade selection, but the command-level WB_ENV default
  // must still make the spawned tests run as `test` when nothing defines WB_ENV.
  it('keeps explicit cascade env and adds the command default', () => {
    expect(withDefaultTestCascadeEnv({ cascadeEnv: 'staging' } as TestCommandArgv)).toEqual({
      cascadeEnv: 'staging',
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
