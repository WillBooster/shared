import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';

import type { TestArgv } from '../../../../src/commands/test.js';
import type { Project } from '../../../../src/project.js';
import type { ScriptArgv } from '../../../../src/scripts/builder.js';
import { normalizeArgs } from '../../../../src/scripts/builder.js';
import {
  BaseScripts,
  buildE2EReadinessCommand,
  buildWaitOnLoopbackCommand,
} from '../../../../src/scripts/execution/baseScripts.js';
import { buildEnvReaderOptionArgs, sharedOptionsBuilder } from '../../../../src/sharedOptionsBuilder.js';
import type * as processUtils from '../../../../src/utils/process.js';
import { buildShellCommand, buildShellEnvironmentAssignment } from '../../../../src/utils/shell.js';
import { buildD1MigrationsApplyCommands } from '../../../../src/utils/wrangler.js';

vi.mock('../../../../src/utils/port.js', () => ({
  ensurePort: vi.fn().mockResolvedValue(3000),
}));

vi.mock('../../../../src/utils/process.js', async (importOriginal: () => Promise<typeof processUtils>) => ({
  ...(await importOriginal()),
  spawnSyncOnExit: vi.fn(),
}));

describe('buildWaitOnLoopbackCommand', () => {
  it('fails before generating an invalid command when the port is missing', () => {
    expect(() => buildWaitOnLoopbackCommand(undefined)).toThrow('Port is required');
    expect(() => buildWaitOnLoopbackCommand('')).toThrow('Port is required');
  });
});

describe('buildE2EReadinessCommand', () => {
  const listeningCommand = 'wait-on -t 600000 -i 2000 tcp:localhost:3000';
  const respondingCommand =
    'curl -s -o /dev/null -m 5 --retry 150 --retry-delay 2 --retry-all-errors http://localhost:3000';

  it('waits for a second HTTP response before direct-server tests start', () => {
    expect(buildE2EReadinessCommand(3000, false)).toBe(
      `${listeningCommand} && ${respondingCommand} && sleep 2 && ${respondingCommand}`
    );
  });

  it('waits for the container application after docker-proxy starts listening', () => {
    expect(buildE2EReadinessCommand(3000, true)).toBe(`${listeningCommand} && ${respondingCommand}`);
  });
});

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

class TestProductionScripts extends BaseScripts {
  constructor() {
    super(false);
  }

  protected startDevProtected(_: Project, _argv: ScriptArgv): string {
    return 'start-dev';
  }

  protected override buildDefaultProductionStartCommands(_project: Project, _argv: ScriptArgv): string[] {
    return ['build', 'start'];
  }

  getMigrationCommands(project: Project): string[] {
    return this.buildMigrationCommands(project);
  }
}

describe('BaseScripts.testE2E', () => {
  const project = {
    env: { WB_ENV: 'test', PORT: '3000' },
    packageJson: { scripts: {} },
    skipLaunchingServerForPlaywright: true,
  } as unknown as Project;

  const scripts = new TestScripts();

  it('stabilizes a direct server before launching Playwright', async () => {
    const command = await scripts.testE2EProduction(
      {
        env: { WB_ENV: 'test', PORT: '3000' },
        packageJson: { scripts: {} },
        skipLaunchingServerForPlaywright: false,
      } as unknown as Project,
      {} as TestArgv,
      {}
    );

    expect(command).toContain(
      'tcp:localhost:3000 && curl -s -o /dev/null -m 5 --retry 150 --retry-delay 2 --retry-all-errors http://localhost:3000 && sleep 2 && curl'
    );
  });

  it('propagates Docker readiness without the direct-server stabilization delay', async () => {
    const command = await scripts.testE2EDocker(
      {
        env: { WB_ENV: 'test', PORT: '3000' },
        packageJson: { scripts: {} },
        declaredEnvKeys: new Set(),
        dockerImageName: 'test-image',
        skipLaunchingServerForPlaywright: false,
      } as unknown as Project,
      {} as TestArgv,
      {}
    );

    expect(command).toContain(
      'tcp:localhost:3000 && curl -s -o /dev/null -m 5 --retry 150 --retry-delay 2 --retry-all-errors http://localhost:3000 && BUN playwright test'
    );
    expect(command).not.toContain('sleep 2');
  });

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

  it('replaces all explicit playwright targets when multiple targets are already present', async () => {
    const command = await scripts.testE2EProduction(
      project,
      { targets: ['test/e2e/a.spec.ts', 'test/e2e/b.spec.ts'] } as TestArgv,
      {
        playwrightArgs: ['test', 'test/e2e/a.spec.ts', 'test/e2e/b.spec.ts', '--headed'],
      }
    );

    expect(command).toContain('BUN playwright test test/e2e/a.spec.ts test/e2e/b.spec.ts --headed');
    expect(command).not.toContain('test/e2e/b.spec.ts test/e2e/b.spec.ts');
  });

  it('replaces all explicit playwright targets while preserving surrounding options', async () => {
    const command = await scripts.testE2EProduction(
      project,
      { targets: ['test/e2e/a.spec.ts', 'test/e2e/b.spec.ts'] } as TestArgv,
      {
        playwrightArgs: ['test', '--headed', 'test/e2e/a.spec.ts', 'test/e2e/b.spec.ts', '--grep', 'hello'],
      }
    );

    expect(command).toContain('BUN playwright test test/e2e/a.spec.ts test/e2e/b.spec.ts --headed --grep hello');
    expect(command).not.toContain('test/e2e/b.spec.ts test/e2e/b.spec.ts');
  });

  it('preserves option values when replacing explicit playwright targets', async () => {
    const command = await scripts.testE2EProduction(project, { targets: ['test/e2e/topPage.spec.ts'] } as TestArgv, {
      playwrightArgs: ['test', '--project', 'chromium'],
    });

    expect(command).toContain('BUN playwright test test/e2e/topPage.spec.ts --project chromium');
  });

  it('preserves forwarded values when explicit targets are provided separately', async () => {
    const command = await scripts.testE2EProduction(project, { targets: ['test/e2e/topPage.spec.ts'] } as TestArgv, {
      playwrightArgs: ['test'],
      forwardedPlaywrightArgs: ['--some-option', 'custom-value'],
    });

    expect(command).toContain('BUN playwright test test/e2e/topPage.spec.ts --some-option custom-value');
  });

  it('preserves test list option values when replacing explicit playwright targets', async () => {
    const command = await scripts.testE2EProduction(project, { targets: ['test/e2e/topPage.spec.ts'] } as TestArgv, {
      playwrightArgs: ['test', '--test-list', 'cases.txt', '--test-list-invert', 'ignored.txt', 'test/e2e/'],
    });

    expect(command).toContain(
      'BUN playwright test test/e2e/topPage.spec.ts --test-list cases.txt --test-list-invert ignored.txt'
    );
    expect(command).not.toContain('test/e2e/ --test-list');
  });

  it('replaces every explicit playwright target after -- while preserving earlier targets', async () => {
    const command = await scripts.testE2EProduction(
      project,
      { targets: ['test/e2e/a.spec.ts', 'test/e2e/b.spec.ts'] } as TestArgv,
      {
        playwrightArgs: ['test', 'test/e2e/original.spec.ts', '--', 'test/e2e/c.spec.ts', 'test/e2e/d.spec.ts'],
      }
    );

    expect(command).toContain('BUN playwright test test/e2e/a.spec.ts test/e2e/b.spec.ts --');
    expect(command).not.toContain('test/e2e/original.spec.ts');
    expect(command).not.toContain('test/e2e/c.spec.ts');
    expect(command).not.toContain('test/e2e/d.spec.ts');
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
      .parseSync(['--cascade-env=staging', '--verbose', 'start', `semi;colon`, `quo'te`]) as unknown as ScriptArgv;
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
      .parseSync(['--cascade-env=staging', 'start', `quo'te`]) as unknown as ScriptArgv;
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
      .parseSync(['--cascade-env=staging', '--auto-cascade-env=false', 'start']) as unknown as ScriptArgv;
    normalizeArgs(argv);

    expect(buildEnvReaderOptionArgs(argv)).toEqual(['--cascade-env=staging', '--auto-cascade-env=false']);

    const command = await scriptsWithWait.startProduction(project, argv);

    expect(command).toContain('--cascade-env=staging');
    expect(command).toContain('--auto-cascade-env=false');
  });

  it('resets file-based Drizzle databases before test starts', async () => {
    const scripts = new TestProductionScripts();
    const drizzleProject = {
      buildCommand: 'build',
      dirPath: '/tmp/app',
      env: { DATABASE_URL: 'file:./drizzle/mount/test.sqlite3', WB_ENV: 'test', PORT: '3000' },
      hasDrizzle: true,
      hasPrisma: false,
      packageJson: { scripts: {} },
      rootDirPath: '/tmp/app',
    } as unknown as Project;

    const command = await scripts.startTest(drizzleProject, {} as ScriptArgv);

    expect(command).toContain('rm -f "/tmp/app/drizzle/mount/test.sqlite3"');
    expect(command).toContain('YARN drizzle-kit migrate');
    expect(command).toContain('build && start');
  });
});

describe('BaseScripts D1 migration selection', () => {
  const scripts = new TestProductionScripts();

  it('does not treat an unrelated drizzle config as a D1 migration mechanism', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-base-scripts-test-'));
    try {
      await fs.writeFile(
        path.join(dirPath, 'wrangler.jsonc'),
        JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: 'app' }] })
      );
      await fs.writeFile(path.join(dirPath, 'drizzle.config.ts'), `export default { dialect: 'postgresql' };`);
      const project = buildD1Project(dirPath);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const migrationCommand = scripts.getMigrationCommands(project).join(' && ');
      expect(migrationCommand).toContain('YARN drizzle-kit migrate');
      expect(migrationCommand).not.toContain('wrangler d1 execute');
      expect(migrationCommand).not.toContain('export DATABASE_URL');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('No D1 migration mechanism detected for DB'));
      warn.mockRestore();
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('uses drizzle-kit when an empty migrations directory is not wrangler-native', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-base-scripts-test-'));
    try {
      await fs.mkdir(path.join(dirPath, 'migrations'));
      await fs.writeFile(
        path.join(dirPath, 'wrangler.jsonc'),
        JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: 'app', migrations_dir: 'migrations' }] })
      );
      await fs.writeFile(path.join(dirPath, 'drizzle.config.ts'), `export default { dialect: 'sqlite' };`);
      const project = buildD1Project(dirPath);

      expect(scripts.getMigrationCommands(project).join(' && ')).toContain('YARN drizzle-kit migrate');
      expect(buildD1MigrationsApplyCommands(project)).toEqual([]);
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('uses wrangler-native migrations when an explicit pattern opts in before the directory exists', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-base-scripts-test-'));
    try {
      await fs.writeFile(
        path.join(dirPath, 'wrangler.jsonc'),
        JSON.stringify({
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'app',
              migrations_dir: 'migrations',
              migrations_pattern: 'migrations/*/migration.sql',
            },
          ],
        })
      );
      await fs.writeFile(path.join(dirPath, 'drizzle.config.ts'), `export default { dialect: 'sqlite' };`);
      const project = buildD1Project(dirPath);

      expect(scripts.getMigrationCommands(project).join(' && ')).not.toContain('YARN drizzle-kit migrate');
      expect(buildD1MigrationsApplyCommands(project).join(' && ')).toContain('YARN wrangler d1 migrations apply app');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('rejects mixed wrangler-native and drizzle-kit D1 layouts', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-base-scripts-test-'));
    try {
      await fs.mkdir(path.join(dirPath, 'native'));
      await fs.writeFile(path.join(dirPath, 'native', '0001.sql'), 'CREATE TABLE native_table (id);');
      await fs.writeFile(
        path.join(dirPath, 'wrangler.jsonc'),
        JSON.stringify({
          d1_databases: [
            { binding: 'NATIVE', database_name: 'native-db', migrations_dir: 'native' },
            { binding: 'DRIZZLE', database_name: 'drizzle-db' },
          ],
        })
      );
      await fs.writeFile(path.join(dirPath, 'drizzle.config.ts'), `export default { dialect: 'sqlite' };`);

      expect(() => scripts.getMigrationCommands(buildD1Project(dirPath))).toThrow(
        'wb does not support mixing wrangler-native and non-native D1 migration layouts.'
      );
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('rejects multiple drizzle-kit D1 bindings', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-base-scripts-test-'));
    try {
      await fs.writeFile(
        path.join(dirPath, 'wrangler.jsonc'),
        JSON.stringify({
          d1_databases: [
            { binding: 'FIRST', database_name: 'first-db' },
            { binding: 'SECOND', database_name: 'second-db' },
          ],
        })
      );
      await fs.writeFile(path.join(dirPath, 'drizzle.config.ts'), `export default { dialect: 'sqlite' };`);

      expect(() => scripts.getMigrationCommands(buildD1Project(dirPath))).toThrow(
        'wb supports drizzle-kit migrations only for a single D1 binding; found multiple.'
      );
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('applies every wrangler-native D1 binding locally', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-base-scripts-test-'));
    try {
      await fs.writeFile(
        path.join(dirPath, 'wrangler.jsonc'),
        JSON.stringify({
          d1_databases: [
            {
              binding: 'FIRST',
              database_name: 'first-db',
              migrations_dir: 'first',
              migrations_pattern: 'first/*.sql',
            },
            {
              binding: 'SECOND',
              database_name: 'second-db',
              migrations_dir: 'second',
              migrations_pattern: 'second/*.sql',
            },
          ],
          env: {
            staging: {
              d1_databases: [{ binding: 'STAGING', database_name: 'staging-db', migrations_dir: 'staging' }],
            },
          },
        })
      );
      const project = buildD1Project(dirPath);
      project.env.CLOUDFLARE_ENV = 'staging';

      expect(buildD1MigrationsApplyCommands(project)).toEqual([
        expect.stringMatching(/^env -u CLOUDFLARE_ENV .*d1 migrations apply first-db/u),
        expect.stringMatching(/^env -u CLOUDFLARE_ENV .*d1 migrations apply second-db/u),
      ]);
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });
});

function buildD1Project(dirPath: string): Project {
  return {
    buildCommand: 'build',
    dirPath,
    env: { WB_ENV: 'test', PORT: '3000' },
    hasDrizzle: true,
    hasPrisma: false,
    packageJson: { scripts: {} },
    rootDirPath: dirPath,
  } as unknown as Project;
}
