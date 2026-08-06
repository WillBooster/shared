import { describe, expect, it } from 'vitest';

import type { TestArgv } from '../../../../src/commands/test.js';
import type { Project } from '../../../../src/project.js';
import { plainAppScripts } from '../../../../src/scripts/execution/plainAppScripts.js';

function createProject(overrides: Record<string, unknown> = {}): Project {
  return {
    env: { WB_ENV: 'test', PORT: '3000' },
    packageJson: { scripts: {} },
    hasPlaywrightWebServerConfig: false,
    hasVitest: false,
    isBunAvailable: true,
    ...overrides,
  } as unknown as Project;
}

describe('PlainAppScripts.testE2EProduction', () => {
  it('runs Playwright directly when the library ships a self-managed webServer fixture', async () => {
    const project = createProject({ hasPlaywrightWebServerConfig: true });

    const command = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {});

    expect(command).toBe('BUN playwright test test/e2e/');
  });

  it('runs test/e2e/ with the unit-test runner when there is no Playwright fixture', async () => {
    const project = createProject();

    const command = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {});

    expect(command).toBe('bun test test/e2e/');
  });

  it('appends `wb test -- ...` args to the unit-test runner instead of dropping the filter', async () => {
    const project = createProject();

    const command = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {
      forwardedPlaywrightArgs: ['-t', 'case name'],
    });

    expect(command).toBe(`bun test test/e2e/ -t 'case name'`);
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
    expect(plainAppScripts.runsE2eOnCi(createProject({ hasPlaywrightWebServerConfig: true }))).toBe(true);
  });
});
