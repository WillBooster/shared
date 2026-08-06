import { describe, expect, it } from 'vitest';

import type { TestArgv } from '../../../../src/commands/test.js';
import type { Project } from '../../../../src/project.js';
import { plainAppScripts } from '../../../../src/scripts/execution/plainAppScripts.js';

function createProject(overrides: Record<string, unknown> = {}): Project {
  return {
    env: { WB_ENV: 'test', PORT: '3000' },
    packageJson: { scripts: {} },
    hasPlaywrightConfig: false,
    hasPlaywrightWebServerConfig: false,
    hasVitest: false,
    isBunAvailable: true,
    ...overrides,
  } as unknown as Project;
}

describe('PlainAppScripts.testE2EProduction', () => {
  it('runs Playwright directly when the library ships a self-managed webServer fixture', async () => {
    const project = createProject({ hasPlaywrightConfig: true, hasPlaywrightWebServerConfig: true });

    const command = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {});

    expect(command).toBe('BUN playwright test test/e2e/');
  });

  it('does nothing when a Playwright config expects an externally managed server', async () => {
    const project = createProject({ hasPlaywrightConfig: true });

    const command = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {});

    expect(command).toBe(`echo 'do nothing.'`);
  });

  it('runs test/e2e/ with the unit-test runner when there is no Playwright config', async () => {
    const project = createProject();

    const command = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {});

    expect(command).toBe('bun test test/e2e/');
  });

  it('translates `wb test -- ...` name filters for the unit-test runner instead of dropping them', async () => {
    const project = createProject();

    for (const forwardedPlaywrightArgs of [['-t', 'case name'], ['--grep', 'case name'], ['--grep=case name']]) {
      const command = await plainAppScripts.testE2EProduction(project, {} as TestArgv, { forwardedPlaywrightArgs });

      expect(command).toBe(`bun test test/e2e/ '-t=case name'`);
    }
  });

  it('keeps only the last name filter and joins it with `=` so hyphen-leading patterns stay values', async () => {
    const project = createProject();

    const lastWins = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {
      forwardedPlaywrightArgs: ['-g', 'alpha', '--grep', 'beta'],
    });
    expect(lastWins).toBe('bun test test/e2e/ -t=beta');

    const hyphenValue = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {
      forwardedPlaywrightArgs: ['--grep=--help'],
    });
    expect(hyphenValue).toBe('bun test test/e2e/ -t=--help');
  });

  it('uses a target forwarded after `--` instead of unioning it with the default test/e2e/', async () => {
    const project = createProject();

    const command = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {
      forwardedPlaywrightArgs: ['test/e2e/foo.test.ts'],
    });

    expect(command).toBe('bun test test/e2e/foo.test.ts');
  });

  it('combines positional targets with targets forwarded after `--`', async () => {
    const project = createProject();

    const command = await plainAppScripts.testE2EProduction(project, { targets: ['test/e2e/a.test.ts'] } as TestArgv, {
      forwardedPlaywrightArgs: ['test/e2e/b.test.ts'],
    });

    expect(command).toBe('bun test test/e2e/a.test.ts test/e2e/b.test.ts');
  });

  it('skips the suite instead of crashing the runner on Playwright-only options', async () => {
    const project = createProject({ hasVitest: true, isBunAvailable: false });

    const command = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {
      forwardedPlaywrightArgs: ['--headed'],
    });

    expect(command).toBe(
      `echo 'Skipping test/e2e/ (cannot forward the Playwright arg to the unit-test runner: --headed).'`
    );
  });

  it('skips the suite instead of running it unfiltered when a name filter lacks its value', async () => {
    const project = createProject();

    for (const [forwardedPlaywrightArgs, reportedArg] of [
      [['--grep'], '--grep'],
      [['--grep', ''], '--grep'],
      [['--grep='], '--grep='],
    ] as const) {
      const command = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {
        forwardedPlaywrightArgs: [...forwardedPlaywrightArgs],
      });

      expect(command).toBe(
        `echo 'Skipping test/e2e/ (cannot forward the Playwright arg to the unit-test runner: ${reportedArg}).'`
      );
    }
  });

  it('forwards explicit e2e targets to the unit-test runner', async () => {
    const project = createProject();

    const command = await plainAppScripts.testE2EProduction(
      project,
      { targets: ['test/e2e/foo.test.ts'] } as TestArgv,
      {}
    );

    expect(command).toBe('bun test test/e2e/foo.test.ts');
  });
});

describe('PlainAppScripts.runsE2eOnCi', () => {
  it('skips CI e2e without a Playwright fixture and allows it with one', () => {
    expect(plainAppScripts.runsE2eOnCi(createProject())).toBe(false);
    expect(
      plainAppScripts.runsE2eOnCi(createProject({ hasPlaywrightConfig: true, hasPlaywrightWebServerConfig: true }))
    ).toBe(true);
  });
});
