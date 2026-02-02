import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import { checkAndKillPortProcess } from '../../utils/port.js';
import type { ScriptArgv } from '../builder.js';
import { toDevNull } from '../builder.js';
import { dockerScripts } from '../dockerScripts.js';
import { prismaScripts } from '../prismaScripts.js';

export interface TestE2EOptions {
  /** '--e2e generate' calls 'codegen http://localhost:8080' */
  playwrightArgs?: string;
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

    return `YARN concurrently --raw --kill-others-on-fail
      "${this.startDevProtected(project, argv)}"
      "${this.waitAndOpenApp(project)}"`;
  }
  async startProduction(project: Project, argv: ScriptArgv): Promise<string> {
    await checkAndKillPortProcess(project.env.PORT, project);
    if (!this.shouldWaitAndOpenApp) return this.startProductionProtected(project, argv);

    return `YARN concurrently --raw --kill-others-on-fail
      "${this.startProductionProtected(project, argv)}"
      "${this.waitAndOpenApp(project)}"`;
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
      && YARN concurrently --raw --kill-others-on-fail
        "${dockerScripts.stopAndStart(project, argv.normalizedDockerOptionsText ?? '', argv.normalizedArgsText ?? '')}"
        "${this.waitAndOpenApp(project)}"`;
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
    return `NODE_ENV="" YARN concurrently --kill-others --raw --success first "${this.startDevProtected(project, argv)}" "${this.waitApp(project)}"`;
  }

  async testE2EProtected(
    project: Project,
    argv: TestArgv,
    startCommand: string,
    { playwrightArgs = 'test test/e2e/' }: TestE2EOptions
  ): Promise<string> {
    const port = await checkAndKillPortProcess(project.env.PORT, project);
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    const playwrightCommand = buildPlaywrightCommand(playwrightArgs, argv.targets, argv.bail);
    if (project.skipLaunchingServerForPlaywright) {
      return `${playwrightCommand}${suffix}`;
    }

    return `YARN concurrently --kill-others --raw --success first
      "${startCommand} && exit 1"
      "wait-on -t 600000 -i 2000 http-get://127.0.0.1:${port}
        && ${playwrightCommand}${suffix}"`;
  }
  // ------------ END: test (e2e) commands ------------

  testUnit(project: Project, argv: TestArgv): string {
    const testTarget = argv.targets?.join(' ') || 'test/unit/';
    if (project.hasVitest) {
      const bailOption = argv.bail ? ' --bail=1' : '';
      // Since this command is referred from other commands, we have to use "vitest run" (non-interactive mode).
      return `YARN vitest run ${testTarget} --color --passWithNoTests --allowOnly --watch=false${bailOption}`;
    } else if (project.isBunAvailable) {
      const bailOption = argv.bail ? ' --bail' : '';
      return `bun test ${testTarget}${bailOption}`;
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

function buildPlaywrightCommand(playwrightArgs: string, targets: TestArgv['targets'], bail?: boolean): string {
  const base = 'BUN playwright';
  const target = targets?.join(' ') || 'test/e2e/';
  if (!playwrightArgs.startsWith('test ') || !targets?.length) {
    return appendPlaywrightBailOption(`${base} ${playwrightArgs}`, bail);
  }

  const rest = playwrightArgs.slice('test '.length).trim();
  const parts = rest.length > 0 ? rest.split(/\s+/) : [];
  if (!parts[0] || parts[0].startsWith('-')) {
    parts.unshift(target);
  } else {
    parts[0] = target;
  }
  return appendPlaywrightBailOption(`${base} test ${parts.join(' ')}`, bail);
}

function appendPlaywrightBailOption(command: string, bail?: boolean): string {
  if (!bail || !command.includes('playwright test')) {
    return command;
  }
  if (/--max-failures(?:=|\s)/.test(command)) {
    return command;
  }
  return `${command} --max-failures=1`;
}
