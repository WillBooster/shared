import { describe, expect, it, vi } from 'vitest';

import type { TestArgv } from '../../../src/commands/test.js';
import type { Project } from '../../../src/project.js';
import type { ScriptArgv } from '../../../src/scripts/builder.js';
import { BaseScripts } from '../../../src/scripts/execution/baseScripts.js';

vi.mock('../../../src/utils/port.js', () => ({
  checkAndKillPortProcess: vi.fn().mockResolvedValue(3000),
}));

class TestScripts extends BaseScripts {
  constructor() {
    super(false);
  }

  protected startDevProtected(_: Project, _argv: ScriptArgv): string {
    return 'start-dev';
  }

  protected override startProductionProtected(_: Project): string {
    return 'start-production';
  }
}

describe('BaseScripts.testE2E', () => {
  const project = {
    env: { WB_ENV: 'test', PORT: '3000' },
    packageJson: { scripts: {} },
    skipLaunchingServerForPlaywright: true,
  } as unknown as Project;

  const scripts = new TestScripts();

  it('uses default target when none specified', async () => {
    const command = await scripts.testE2EProduction(project, {} as TestArgv, {});
    expect(command).toContain('BUN playwright test test/e2e/');
  });

  it('passes custom target to playwright', async () => {
    const command = await scripts.testE2EProduction(project, { targets: ['test/e2e/topPage.spec.ts'] } as TestArgv, {});
    expect(command).toContain('BUN playwright test test/e2e/topPage.spec.ts');
  });

  it('keeps additional playwright args when replacing target', async () => {
    const command = await scripts.testE2EProduction(project, { targets: ['test/e2e/topPage.spec.ts'] } as TestArgv, {
      playwrightArgs: 'test test/e2e/ --headed',
    });
    expect(command).toContain('BUN playwright test test/e2e/topPage.spec.ts --headed');
  });
});
