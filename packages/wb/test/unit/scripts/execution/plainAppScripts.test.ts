import { describe, expect, it } from 'vitest';

import type { TestArgv } from '../../../../src/commands/test.js';
import type { Project } from '../../../../src/project.js';
import { plainAppScripts } from '../../../../src/scripts/execution/plainAppScripts.js';

describe('PlainAppScripts.testE2EProduction', () => {
  it('runs Playwright directly when the library ships a self-managed webServer fixture', async () => {
    const project = {
      env: { WB_ENV: 'test', PORT: '3000' },
      packageJson: { scripts: {} },
      hasPlaywrightWebServerConfig: true,
    } as unknown as Project;

    const command = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {});

    expect(command).toBe('BUN playwright test test/e2e/');
  });

  it('does nothing when the library has no Playwright fixture', async () => {
    const project = {
      env: { WB_ENV: 'test', PORT: '3000' },
      packageJson: { scripts: {} },
      hasPlaywrightWebServerConfig: false,
    } as unknown as Project;

    const command = await plainAppScripts.testE2EProduction(project, {} as TestArgv, {});

    expect(command).toBe(`echo 'do nothing.'`);
  });
});
