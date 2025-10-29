import { describe, expect, it } from 'vitest';

import type { TestArgv } from '../../../src/commands/test.js';
import type { Project } from '../../../src/project.js';
import { BaseScripts } from '../../../src/scripts/execution/baseScripts.js';

class TestScripts extends BaseScripts {
  override start(): string {
    return '';
  }

  override startProduction(): string {
    return '';
  }

  override startTest(): string {
    return '';
  }

  override testStart(): Promise<string> {
    return Promise.resolve('');
  }
}

describe('BaseScripts.testE2E', () => {
  const project = {
    env: { WB_ENV: 'test', PORT: '3000' },
    packageJson: { scripts: {} },
    skipLaunchingServerForPlaywright: true,
  } as unknown as Project;

  const scripts = new TestScripts();

  it('uses default target when none specified', () => {
    const command = scripts.testE2E(project, {} as TestArgv, {});
    expect(command).toContain('BUN playwright test test/e2e/');
  });

  it('passes custom target to playwright', () => {
    const command = scripts.testE2E(project, { targets: ['test/e2e/topPage.spec.ts'] } as TestArgv, {});
    expect(command).toContain('BUN playwright test test/e2e/topPage.spec.ts');
  });

  it('keeps additional playwright args when replacing target', () => {
    const command = scripts.testE2E(project, { targets: ['test/e2e/topPage.spec.ts'] } as TestArgv, {
      playwrightArgs: 'test test/e2e/ --headed',
    });
    expect(command).toContain('BUN playwright test test/e2e/topPage.spec.ts --headed');
  });
});
