import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import { buildEnvReaderOptionArgs } from '../../sharedOptionsBuilder.js';
import { checkAndKillPortProcess } from '../../utils/port.js';
import { buildShellCommand, buildShellEnvironmentAssignment } from '../../utils/shell.js';
import type { ScriptArgv } from '../builder.js';
import { toDevNull } from '../builder.js';
import { dockerScripts } from '../dockerScripts.js';
import { prismaScripts } from '../prismaScripts.js';

export interface TestE2EOptions {
  /** '--e2e generate' calls 'codegen http://localhost:8080' */
  playwrightArgs?: string[];
}

/**
 * A collection of scripts for executing an app.
 * Note that YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
export abstract class BaseScripts {
  private readonly shouldWaitAndOpenApp: boolean;
  protected constructor(shouldWaitAndOpenApp: boolean) {
    this.shouldWaitAndOpenApp = shouldWaitAndOpenApp;
  }

  buildDocker(project: Project, version: string): string {
    return dockerScripts.buildImage(project, version);
  }

  // ------------ START: start commands ------------
  async startDev(project: Project, argv: ScriptArgv): Promise<string> {
    await checkAndKillPortProcess(project.env.PORT, project);
    if (!this.shouldWaitAndOpenApp) return this.startDevProtected(project, argv);

    return buildShellCommand([
      'YARN',
      'wb',
      'concurrently',
      ...buildEnvReaderOptionArgs(argv),
      '--kill-others-on-fail',
      this.startDevProtected(project, argv),
      this.waitAndOpenApp(project),
    ]);
  }
  async startProduction(project: Project, argv: ScriptArgv): Promise<string> {
    await checkAndKillPortProcess(project.env.PORT, project);
    if (!this.shouldWaitAndOpenApp) return this.startProductionProtected(project, argv);

    return buildShellCommand([
      'YARN',
      'wb',
      'concurrently',
      ...buildEnvReaderOptionArgs(argv),
      '--kill-others-on-fail',
      this.startProductionProtected(project, argv),
      this.waitAndOpenApp(project),
    ]);
  }
  async startTest(project: Project, argv: ScriptArgv): Promise<string> {
    await checkAndKillPortProcess(project.env.PORT, project);
    return this.startProductionProtected(project, argv);
  }
  async startDocker(project: Project, argv: ScriptArgv): Promise<string> {
    await checkAndKillPortProcess(project.env.PORT, project);
    if (!this.shouldWaitAndOpenApp) {
      return `${this.buildDocker(project, 'development')}
      && ${dockerScripts.stopAndStart(project, argv.normalizedDockerOptionsText ?? '', argv.normalizedArgsText ?? '')}`;
    }

    return `${this.buildDocker(project, 'development')}
      && ${buildShellCommand([
        'YARN',
        'wb',
        'concurrently',
        ...buildEnvReaderOptionArgs(argv),
        '--kill-others-on-fail',
        dockerScripts.stopAndStart(project, argv.normalizedDockerOptionsText ?? '', argv.normalizedArgsText ?? ''),
        this.waitAndOpenApp(project),
      ])}`;
  }

  protected abstract startDevProtected(_: Project, argv: ScriptArgv): string;
  protected startProductionProtected(project: Project, argv: ScriptArgv): string {
    const ecosystemConfigPath = findEcosystemConfigPath(project);
    const commands =
      ecosystemConfigPath === undefined
        ? [
            `YARN wb buildIfNeeded ${argv.verbose ? '--verbose' : ''}`.trim(),
            `node dist/index.js ${argv.normalizedArgsText ?? ''}`.trim(),
          ]
        : [project.buildCommand, `pm2-runtime start --no-autorestart ${ecosystemConfigPath}`];

    return [...(project.hasPrisma ? prismaScripts.migrate(project).split('&&') : []), ...commands]
      .filter(Boolean)
      .map((cmd) => `${cmd} ${toDevNull(argv)}`.trim())
      .join(' && ');
  }
  // ------------ END: start commands ------------

  // ------------ START: test (e2e) commands ------------
  testE2EDev(project: Project, argv: TestArgv, options: TestE2EOptions): Promise<string> {
    return this.testE2EProtected(project, argv, this.startDevProtected(project, argv), options);
  }
  testE2EProduction(project: Project, argv: TestArgv, options: TestE2EOptions): Promise<string> {
    return this.testE2EProtected(project, argv, this.startProductionProtected(project, argv), options);
  }
  testE2EDocker(project: Project, argv: TestArgv, options: TestE2EOptions): Promise<string> {
    return this.testE2EProtected(project, argv, dockerScripts.stopAndStart(project), options);
  }
  async testStart(project: Project, argv: ScriptArgv): Promise<string> {
    await checkAndKillPortProcess(project.env.PORT, project);
    // Use empty NODE_ENV to avoid "production" mode in some frameworks like Blitz.js.
    return `${buildShellEnvironmentAssignment('NODE_ENV', '')} ${buildShellCommand([
      'YARN',
      'wb',
      'concurrently',
      ...buildEnvReaderOptionArgs(argv),
      '--kill-others',
      '--success',
      'first',
      this.startDevProtected(project, argv),
      this.waitApp(project),
    ])}`;
  }

  async testE2EProtected(
    project: Project,
    argv: TestArgv,
    startCommand: string,
    { playwrightArgs = ['test', 'test/e2e/'] }: TestE2EOptions
  ): Promise<string> {
    const port = await checkAndKillPortProcess(project.env.PORT, project);
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    const playwrightCommand = buildPlaywrightCommand(playwrightArgs, argv.targets, argv.bail);
    if (project.skipLaunchingServerForPlaywright) {
      return `${playwrightCommand}${suffix}`;
    }

    return buildShellCommand([
      'YARN',
      'wb',
      'concurrently',
      ...buildEnvReaderOptionArgs(argv),
      '--kill-others',
      '--success',
      'first',
      `${startCommand} && exit 1`,
      `wait-on -t 600000 -i 2000 http-get://127.0.0.1:${port}
        && ${playwrightCommand}${suffix}`,
    ]);
  }
  // ------------ END: test (e2e) commands ------------

  testUnit(project: Project, argv: TestArgv): string {
    const targets = argv.targets?.map(String);
    if (project.hasVitest) {
      // Since this command is referred from other commands, we have to use "vitest run" (non-interactive mode).
      return buildShellCommand([
        'YARN',
        'vitest',
        'run',
        ...(targets?.length ? targets : ['test/unit/']),
        '--color',
        '--passWithNoTests',
        '--allowOnly',
        '--watch=false',
        ...(argv.bail ? ['--bail=1'] : []),
      ]);
    } else if (project.isBunAvailable) {
      return buildShellCommand([
        'bun',
        'test',
        ...(targets?.length ? targets : ['test/unit/']),
        ...(argv.bail ? ['--bail'] : []),
      ]);
    }
    return 'echo "No tests."';
  }

  protected waitApp(project: Project): string {
    const port = project.env.PORT;
    return `wait-on -t 10000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 500 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 1000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 2000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 20000 -i 4000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 60000 -i 5000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 90000 -i 10000 http-get://127.0.0.1:${port}`;
  }

  protected waitAndOpenApp(project: Project): string {
    const port = project.env.PORT;
    return `${this.waitApp(
      project
    )} || wait-on http-get://127.0.0.1:${port} && open-cli http://\${HOST:-localhost}:${port}`;
  }
}

function findEcosystemConfigPath(project: Project): string | undefined {
  try {
    return project.findFile('ecosystem.config.cjs');
  } catch {
    return;
  }
}

function buildPlaywrightCommand(playwrightArgs: string[], targets: TestArgv['targets'], bail?: boolean): string {
  const base = ['BUN', 'playwright'];
  const normalizedTargets = targets?.map(String);
  if (playwrightArgs[0] !== 'test' || !normalizedTargets?.length) {
    return appendPlaywrightBailOption([...base, ...playwrightArgs], bail);
  }

  const rest = playwrightArgs.slice(1);
  let restWithoutExplicitTarget = rest;
  const firstTargetIndex = findFirstExplicitPlaywrightTargetIndex(rest);
  if (firstTargetIndex !== -1) {
    restWithoutExplicitTarget = rest.filter((_, index) => index !== firstTargetIndex);
  }
  return appendPlaywrightBailOption([...base, 'test', ...normalizedTargets, ...restWithoutExplicitTarget], bail);
}

function appendPlaywrightBailOption(commandArgs: string[], bail?: boolean): string {
  const playwrightIndex = commandArgs.indexOf('playwright');
  const isPlaywrightTestCommand = playwrightIndex !== -1 && commandArgs[playwrightIndex + 1] === 'test';
  if (!bail || !isPlaywrightTestCommand) {
    return buildShellCommand(commandArgs);
  }
  if (commandArgs.some((arg) => arg === '--max-failures' || arg.startsWith('--max-failures='))) {
    return buildShellCommand(commandArgs);
  }
  return buildShellCommand([...commandArgs, '--max-failures=1']);
}

function findFirstExplicitPlaywrightTargetIndex(args: string[]): number {
  let pendingValueMode: 'optional' | 'required' | undefined;

  for (const [index, arg] of args.entries()) {
    if (pendingValueMode) {
      if (pendingValueMode === 'required' || !arg.startsWith('-')) {
        pendingValueMode = undefined;
        continue;
      }
      pendingValueMode = undefined;
    }

    if (arg === '--') {
      return index + 1 < args.length ? index + 1 : -1;
    }
    if (arg.startsWith('--')) {
      if (arg.includes('=')) continue;
      if (PLAYWRIGHT_TEST_OPTIONS_WITH_REQUIRED_VALUES.has(arg)) {
        pendingValueMode = 'required';
      } else if (PLAYWRIGHT_TEST_OPTIONS_WITH_OPTIONAL_VALUES.has(arg)) {
        pendingValueMode = 'optional';
      }
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      const shortOption = arg.slice(0, 2);
      if (arg.length === 2 && PLAYWRIGHT_TEST_SHORT_OPTIONS_WITH_REQUIRED_VALUES.has(shortOption)) {
        pendingValueMode = 'required';
      }
      continue;
    }
    return index;
  }

  return -1;
}

const PLAYWRIGHT_TEST_OPTIONS_WITH_REQUIRED_VALUES = new Set([
  '--browser',
  '--config',
  '--grep',
  '--grep-invert',
  '--global-timeout',
  '--max-failures',
  '--output',
  '--project',
  '--repeat-each',
  '--reporter',
  '--retries',
  '--shard',
  '--timeout',
  '--trace',
  '--tsconfig',
  '--ui-host',
  '--ui-port',
  '--ui-title',
  '--workers',
]);

const PLAYWRIGHT_TEST_OPTIONS_WITH_OPTIONAL_VALUES = new Set([
  '--only-changed',
  '--update-snapshots',
  '--update-source-method',
]);

const PLAYWRIGHT_TEST_SHORT_OPTIONS_WITH_REQUIRED_VALUES = new Set(['-c', '-g', '-j']);
