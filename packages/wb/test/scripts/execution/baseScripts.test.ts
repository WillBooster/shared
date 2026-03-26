import { describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';

import type { TestArgv } from '../../../src/commands/test.js';
import type { Project } from '../../../src/project.js';
import type { ScriptArgv } from '../../../src/scripts/builder.js';
import { normalizeArgs } from '../../../src/scripts/builder.js';
import { BaseScripts } from '../../../src/scripts/execution/baseScripts.js';
import { buildEnvReaderOptionArgs, sharedOptionsBuilder } from '../../../src/sharedOptionsBuilder.js';
import { buildShellCommand, buildShellEnvironmentAssignment } from '../../../src/utils/shell.js';

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

class TestScriptsWithWait extends BaseScripts {
  constructor() {
    super(true);
  }

  getWaitApp(project: Project): string {
    return this.waitApp(project);
  }

  getWaitAndOpenApp(project: Project): string {
    return this.waitAndOpenApp(project);
  }

  protected startDevProtected(_: Project, argv: ScriptArgv): string {
    return `start-dev ${argv.normalizedArgsText ?? ''}`.trim();
  }

  protected override startProductionProtected(_: Project, argv: ScriptArgv): string {
    return `start-production ${argv.normalizedArgsText ?? ''}`.trim();
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
      playwrightArgs: ['test', 'test/e2e/', '--headed'],
    });
    expect(command).toContain('BUN playwright test test/e2e/topPage.spec.ts --headed');
  });

  it('replaces the first explicit playwright target even when options come first', async () => {
    const command = await scripts.testE2EProduction(project, { targets: ['test/e2e/topPage.spec.ts'] } as TestArgv, {
      playwrightArgs: ['test', '--headed', 'test/e2e/', '--grep', 'hello'],
    });
    expect(command).toContain('BUN playwright test test/e2e/topPage.spec.ts --headed --grep hello');
  });

  it('preserves option values when replacing explicit playwright targets', async () => {
    const command = await scripts.testE2EProduction(project, { targets: ['test/e2e/topPage.spec.ts'] } as TestArgv, {
      playwrightArgs: ['test', '--project', 'chromium'],
    });

    expect(command).toContain('BUN playwright test test/e2e/topPage.spec.ts --project chromium');
  });

  it('does not add max-failures to non-test playwright subcommands', async () => {
    const command = await scripts.testE2EProduction(project, {} as TestArgv, {
      playwrightArgs: ['codegen', 'http://localhost:3000'],
    });

    expect(command).toBe('BUN playwright codegen http://localhost:3000');
  });

  it('escapes start commands passed to wb concurrently', async () => {
    const scriptsWithWait = new TestScriptsWithWait();
    const argv = yargs()
      .options(sharedOptionsBuilder)
      .parseSync([
        '--env',
        '.env.test',
        '--include-root-env=false',
        '--cascade-env=staging',
        '--check-env',
        '.env.custom',
        '--verbose',
        'start',
        `semi;colon`,
        `quo'te`,
      ]) as unknown as ScriptArgv;
    normalizeArgs(argv);

    const command = await scriptsWithWait.startDev(project, argv);

    expect(command).toBe(
      buildShellCommand([
        'YARN',
        'wb',
        'concurrently',
        ...buildEnvReaderOptionArgs(argv),
        '--kill-others-on-fail',
        `start-dev ${argv.normalizedArgsText}`,
        scriptsWithWait.getWaitAndOpenApp(project),
      ])
    );
  });

  it('escapes test-start commands passed to wb concurrently', async () => {
    const scriptsWithWait = new TestScriptsWithWait();
    const argv = yargs()
      .options(sharedOptionsBuilder)
      .parseSync(['--env', '.env.test', '--include-root-env=false', 'start', `quo'te`]) as unknown as ScriptArgv;
    normalizeArgs(argv);

    const command = await scriptsWithWait.testStart(project, argv);

    expect(command).toBe(
      `${buildShellEnvironmentAssignment('NODE_ENV', '')} ${buildShellCommand([
        'YARN',
        'wb',
        'concurrently',
        ...buildEnvReaderOptionArgs(argv),
        '--kill-others',
        '--success',
        'first',
        `start-dev ${argv.normalizedArgsText}`,
        scriptsWithWait.getWaitApp(project),
      ])}`
    );
  });

  it('preserves explicit env-loading overrides when building nested concurrently commands', async () => {
    const scriptsWithWait = new TestScriptsWithWait();
    const argv = yargs()
      .options(sharedOptionsBuilder)
      .parseSync([
        '--env',
        '.env.test',
        '--env',
        '.env.local.test',
        '--include-root-env=false',
        '--auto-cascade-env=false',
        '--check-env=.env.required',
        'start',
      ]) as unknown as ScriptArgv;
    normalizeArgs(argv);

    expect(buildEnvReaderOptionArgs(argv)).toEqual([
      '--env=.env.test',
      '--env=.env.local.test',
      '--auto-cascade-env=false',
      '--include-root-env=false',
      '--check-env=.env.required',
    ]);

    const command = await scriptsWithWait.startProduction(project, argv);

    expect(command).toContain('--env=.env.test');
    expect(command).toContain('--env=.env.local.test');
    expect(command).toContain('--include-root-env=false');
    expect(command).toContain('--auto-cascade-env=false');
    expect(command).toContain('--check-env=.env.required');
  });
});
