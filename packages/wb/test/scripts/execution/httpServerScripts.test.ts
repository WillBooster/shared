import { describe, expect, it, vi } from 'vitest';

import type { TestArgv } from '../../../src/commands/test.js';
import type { Project } from '../../../src/project.js';
import { httpServerScripts } from '../../../src/scripts/execution/httpServerScripts.js';

vi.mock('../../../src/utils/port.js', () => ({
  checkAndKillPortProcess: vi.fn().mockResolvedValue(3000),
}));

describe('HttpServerScripts.testE2E', () => {
  it('uses vitest when playwright config is missing', async () => {
    const project = {
      env: { WB_ENV: 'test', PORT: '3000' },
      packageJson: { scripts: {} },
      hasPlaywrightConfig: false,
    } as unknown as Project;

    const command = await httpServerScripts.testE2EProduction(project, {} as TestArgv, {});
    expect(command).toContain('vitest run test/e2e/');
  });

  it('uses playwright when playwright config is available', async () => {
    const project = {
      env: { WB_ENV: 'test', PORT: '3000' },
      packageJson: { scripts: {} },
      hasPlaywrightConfig: true,
      skipLaunchingServerForPlaywright: true,
    } as unknown as Project;

    const command = await httpServerScripts.testE2EProduction(project, {} as TestArgv, {});
    expect(command).toContain('BUN playwright test test/e2e/');
  });
});
