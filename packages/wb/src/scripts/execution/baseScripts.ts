import path from 'node:path';

import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import { isProjectEnvironment } from '../../project.js';
import { buildEnvReaderOptionArgs } from '../../sharedOptionsBuilder.js';
import { checkAndKillPortProcess } from '../../utils/port.js';
import { buildShellCommand, buildShellEnvironmentAssignment } from '../../utils/shell.js';
import {
  findD1MigrationsDirPath,
  findWranglerConfigPath,
  getLocalWranglerStateDir,
  wrapWithLocalD1DatabaseUrl,
} from '../../utils/wrangler.js';
import type { ScriptArgv } from '../builder.js';
import { toDevNull } from '../builder.js';
import { dockerScripts } from '../dockerScripts.js';
import { drizzleScripts } from '../drizzleScripts.js';
import { prismaScripts } from '../prismaScripts.js';

export interface TestE2EOptions {
  /** '--e2e generate' calls 'codegen http://localhost:8080' */
  playwrightArgs?: string[];
  /** Raw Playwright args forwarded after `wb test -- ...` */
  forwardedPlaywrightArgs?: string[];
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
    const customStartScriptPath = findCustomProductionStartScriptPath(project);
    if (customStartScriptPath) {
      const startCommand =
        `${buildShellCommand(['bash', customStartScriptPath])} ${argv.normalizedArgsText ?? ''}`.trim();
      // A start script found at the monorepo root (cf. Project.findFile) is written to run from
      // the root, like Docker's WORKDIR, so its cwd must be the directory containing scripts/.
      const scriptRootDirPath = path.dirname(path.dirname(customStartScriptPath));
      return this.buildProductionCommand(project, argv, [
        project.buildCommand,
        scriptRootDirPath === project.dirPath
          ? startCommand
          : `(${buildShellCommand(['cd', scriptRootDirPath])} && ${startCommand})`,
      ]);
    }

    const ecosystemConfigPath = findEcosystemConfigPath(project);
    const commands = ecosystemConfigPath
      ? [project.buildCommand, `pm2-runtime start --no-autorestart ${ecosystemConfigPath}`]
      : this.buildDefaultProductionStartCommands(project, argv);

    return this.buildProductionCommand(project, argv, commands);
  }

  protected buildDefaultProductionStartCommands(project: Project, argv: ScriptArgv): string[] {
    return [
      project.buildCommand,
      `${project.isBunAvailable ? 'bun' : 'node'} dist/index.js ${argv.normalizedArgsText ?? ''}`.trim(),
    ];
  }

  protected buildProductionCommand(project: Project, argv: ScriptArgv, commands: string[]): string {
    // Test-environment wrangler state is disposable; wipe it entirely (not just D1) before
    // migrating, since stale KV cache entries or Durable Object storage can break e2e tests.
    const wranglerStateWipeCommands =
      isProjectEnvironment(project, 'test') && findWranglerConfigPath(project)
        ? [`rm -Rf "${getLocalWranglerStateDir(project)}"`]
        : [];
    // A project whose D1 bindings carry wrangler-native migrations applies them with wrangler
    // (see WorkersScripts / buildD1MigrationsApplyCommand). Running drizzle-kit migrate against
    // the same local D1 would apply the same SQL twice — drizzle's generated statements are not
    // idempotent (`CREATE INDEX` without IF NOT EXISTS) — so drizzle stays ORM-only there.
    const migratesD1WithWrangler = !!findD1MigrationsDirPath(project);
    const migrationCommands = [
      ...wranglerStateWipeCommands,
      ...(project.hasPrisma ? [prismaScripts.migrate(project)] : []),
      ...(project.hasDrizzle && !migratesD1WithWrangler
        ? [wrapWithLocalD1DatabaseUrl(project, drizzleScripts.migrateForStart(project))]
        : []),
    ];
    // Splitting may cut through a `(cd … && …)` subshell, but rejoining with ' && ' and per-piece
    // redirects keeps the script valid, and wb-generated paths never contain '&&'.
    return [...migrationCommands.flatMap((cmd) => cmd.split('&&')), ...commands]
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
    project.env.PORT ||= '3000';
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
    { forwardedPlaywrightArgs = [], playwrightArgs = ['test', 'test/e2e/'] }: TestE2EOptions
  ): Promise<string> {
    project.env.PORT ||= '3000';
    const port = await checkAndKillPortProcess(project.env.PORT, project);
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    const playwrightCommand = buildPlaywrightCommand(playwrightArgs, argv.targets, argv.bail, forwardedPlaywrightArgs);
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
      `${buildWaitOnLoopbackCommand(port, '-t 600000 -i 2000')}
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
    return `${buildWaitOnLoopbackCommand(port, '-t 10000')} 2> /dev/null
      || ${buildWaitOnLoopbackCommand(port, '-t 10000 -i 500')} 2> /dev/null
      || ${buildWaitOnLoopbackCommand(port, '-t 10000 -i 1000')} 2> /dev/null
      || ${buildWaitOnLoopbackCommand(port, '-t 10000 -i 2000')} 2> /dev/null
      || ${buildWaitOnLoopbackCommand(port, '-t 20000 -i 4000')} 2> /dev/null
      || ${buildWaitOnLoopbackCommand(port, '-t 60000 -i 5000')} 2> /dev/null
      || ${buildWaitOnLoopbackCommand(port, '-t 90000 -i 10000')}`;
  }

  protected waitAndOpenApp(project: Project): string {
    const port = project.env.PORT;
    return `${this.waitApp(
      project
    )} || ${buildWaitOnLoopbackCommand(port)} && open-cli http://\${HOST:-localhost}:${port}`;
  }
}

/**
 * Builds a wait-on boot check polling `http-get://localhost:<port>`. `localhost` (not `127.0.0.1`)
 * lets Node's Happy Eyeballs try both address families: on macOS, dev servers without an explicit
 * host (e.g. vinext/Vite) can bind IPv6-only (`::1`), so an IPv4-only poll would hang until timeout
 * even though the server is up. The `NO_PROXY`/`no_proxy` prefix keeps the loopback poll off HTTP
 * proxies: wait-on's axios applies `HTTP(S)_PROXY` env vars unless `NO_PROXY` matches the polled
 * host, and existing `NO_PROXY` conventions may list `127.0.0.1` without `localhost`.
 */
export function buildWaitOnLoopbackCommand(port: string | number | undefined, waitOnArgs?: string): string {
  return `NO_PROXY=localhost no_proxy=localhost wait-on ${waitOnArgs ? `${waitOnArgs} ` : ''}http-get://localhost:${port}`;
}

function findCustomProductionStartScriptPath(project: Project): string | undefined {
  try {
    return project.findFile('scripts/start-production.sh');
  } catch {
    return;
  }
}

function findEcosystemConfigPath(project: Project): string | undefined {
  try {
    return project.findFile('ecosystem.config.cjs');
  } catch {
    return;
  }
}

function buildPlaywrightCommand(
  playwrightArgs: string[],
  targets: TestArgv['targets'],
  bail?: boolean,
  forwardedPlaywrightArgs: string[] = []
): string {
  const base = ['BUN', 'playwright'];
  const normalizedTargets = targets?.map(String);
  if (playwrightArgs[0] !== 'test' || !normalizedTargets?.length) {
    return appendPlaywrightBailOption([...base, ...playwrightArgs, ...forwardedPlaywrightArgs], bail);
  }

  const rest = playwrightArgs.slice(1);
  const explicitTargetIndexes = findExplicitPlaywrightTargetIndexes(rest);
  const restWithoutExplicitTarget =
    explicitTargetIndexes.length === 0 ? rest : rest.filter((_, index) => !explicitTargetIndexes.includes(index));
  return appendPlaywrightBailOption(
    [...base, 'test', ...normalizedTargets, ...restWithoutExplicitTarget, ...forwardedPlaywrightArgs],
    bail
  );
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

export function findExplicitPlaywrightTargetIndexes(args: string[]): number[] {
  let pendingValueMode: 'optional' | 'required' | undefined;
  const targetIndexes: number[] = [];

  for (const [index, arg] of args.entries()) {
    if (pendingValueMode) {
      if (pendingValueMode === 'required' || !arg.startsWith('-')) {
        pendingValueMode = undefined;
        continue;
      }
      pendingValueMode = undefined;
    }

    if (arg === '--') {
      return [...targetIndexes, ...args.slice(index + 1).map((_, offset) => index + 1 + offset)];
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
    targetIndexes.push(index);
  }

  return targetIndexes;
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
  '--test-list',
  '--test-list-invert',
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
