import { describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';

import type { TestArgv } from '../../../../src/commands/test.js';
import type { Project } from '../../../../src/project.js';
import { normalizeArgs } from '../../../../src/scripts/builder.js';
import { httpServerScripts } from '../../../../src/scripts/execution/httpServerScripts.js';
import { buildEnvReaderOptionArgs, sharedOptionsBuilder } from '../../../../src/sharedOptionsBuilder.js';
import { buildShellCommand } from '../../../../src/utils/shell.js';

vi.mock('../../../../src/utils/port.js', () => ({
  checkAndKillPortProcess: vi.fn().mockResolvedValue(3000),
}));

describe('HttpServerScripts.testE2E', () => {
  it('uses vitest when playwright config is missing', async () => {
    const project = {
      env: { WB_ENV: 'test', PORT: '3000' },
      packageJson: { scripts: {} },
      hasPlaywrightConfig: false,
      hasVitest: true,
      hasPrisma: false,
      buildCommand: 'echo "no build"',
      findFile: vi.fn().mockImplementation(() => {
        throw new Error('File not found');
      }),
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
      hasPrisma: false,
      buildCommand: 'echo "no build"',
      findFile: vi.fn().mockImplementation(() => {
        throw new Error('File not found');
      }),
    } as unknown as Project;

    const command = await httpServerScripts.testE2EProduction(project, {} as TestArgv, {});
    expect(command).toContain('BUN playwright test test/e2e/');
  });

  it('escapes vitest targets inside concurrently commands', async () => {
    const project = {
      env: { WB_ENV: 'test', PORT: '3000' },
      packageJson: { scripts: {} },
      hasPlaywrightConfig: false,
      hasVitest: true,
      hasPrisma: false,
      buildCommand: 'echo "no build"',
      findFile: vi.fn().mockImplementation(() => {
        throw new Error('File not found');
      }),
    } as unknown as Project;

    const command = await httpServerScripts.testE2EProduction(
      project,
      { targets: [`test/e2e/quo'te.spec.ts`, 'test/e2e/space path.spec.ts'] } as TestArgv,
      {}
    );

    expect(command).toBe(
      buildShellCommand([
        'YARN',
        'wb',
        'concurrently',
        '--kill-others',
        '--success',
        'first',
        'echo "no build" && node dist/index.js && exit 1',
        `NO_PROXY=localhost no_proxy=localhost wait-on -t 600000 -i 2000 http-get://localhost:3000 && ${buildShellCommand(
          [
            'YARN',
            'vitest',
            'run',
            `test/e2e/quo'te.spec.ts`,
            'test/e2e/space path.spec.ts',
            '--passWithNoTests',
            '--allowOnly',
            '--watch=false',
          ]
        )}`,
      ])
    );
  });

  it('preserves env-loading overrides inside nested concurrently commands', async () => {
    const project = {
      env: { WB_ENV: 'test', PORT: '3000' },
      packageJson: { scripts: {} },
      hasPlaywrightConfig: false,
      hasPrisma: false,
      buildCommand: 'echo "no build"',
      findFile: vi.fn().mockImplementation(() => {
        throw new Error('File not found');
      }),
    } as unknown as Project;
    const argv = yargs()
      .options(sharedOptionsBuilder)
      .parseSync([
        '--env',
        '.env.test',
        '--env',
        '.env.local.test',
        '--include-root-env=false',
        '--auto-cascade-env=false',
        'test',
      ]) as unknown as TestArgv;
    normalizeArgs(argv);

    const command = await httpServerScripts.testE2EProduction(project, argv, {});

    expect(buildEnvReaderOptionArgs(argv)).toEqual([
      '--env=.env.test',
      '--env=.env.local.test',
      '--auto-cascade-env=false',
      '--include-root-env=false',
    ]);
    expect(command).toContain('--env=.env.test');
    expect(command).toContain('--env=.env.local.test');
    expect(command).toContain('--include-root-env=false');
    expect(command).toContain('--auto-cascade-env=false');
  });
});
