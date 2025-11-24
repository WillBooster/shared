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
  protected abstract startDevProtected(_: Project, argv: ScriptArgv): string;
  protected startProductionProtected(project: Project, argv: ScriptArgv): string {
    return [
      ...(project.hasPrisma ? prismaScripts.migrate(project).split('&&') : []),
      project.buildCommand,
      `pm2-runtime start ${project.findFile('ecosystem.config.cjs')}`,
    ]
      .filter(Boolean)
      .map((cmd) => `${cmd} ${toDevNull(argv)}`.trim())
      .join(' && ');
  }

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
      && ${dockerScripts.stopAndStart(
        project,
        false,
        argv.normalizedDockerOptionsText ?? '',
        argv.normalizedArgsText ?? ''
      )}`;
    }

    return `${this.buildDocker(project, 'development')}
      && YARN concurrently --raw --kill-others-on-fail
        "${dockerScripts.stopAndStart(
          project,
          false,
          argv.normalizedDockerOptionsText ?? '',
          argv.normalizedArgsText ?? ''
        )}"
        "${this.waitAndOpenApp(project)}"`;
  }
  // ------------ END: start commands ------------

  // ------------ START: test (e2e) commands ------------
  testE2EDev(project: Project, argv: TestArgv, options: TestE2EOptions): Promise<string> {
    return this.testE2EPrivate(project, argv, this.startDevProtected(project, argv), options);
  }
  testE2EProduction(project: Project, argv: TestArgv, options: TestE2EOptions): Promise<string> {
    return this.testE2EPrivate(project, argv, this.startProductionProtected(project, argv), options);
  }
  testE2EDocker(project: Project, argv: TestArgv, options: TestE2EOptions): Promise<string> {
    return this.testE2EPrivate(project, argv, dockerScripts.stopAndStart(project, true), options);
  }
  async testStart(project: Project, argv: ScriptArgv): Promise<string> {
    await checkAndKillPortProcess(project.env.PORT, project);
    return `YARN concurrently --kill-others --raw --success first "${this.startDevProtected(project, argv)}" "${this.waitApp(project)}"`;
  }

  private async testE2EPrivate(
    project: Project,
    argv: TestArgv,
    startCommand: string,
    { playwrightArgs = 'test test/e2e/' }: TestE2EOptions
  ): Promise<string> {
    const port = await checkAndKillPortProcess(project.env.PORT, project);
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    const playwrightCommand = buildPlaywrightCommand(playwrightArgs, argv.targets);
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
      // Since this command is referred from other commands, we have to use "vitest run" (non-interactive mode).
      return `YARN vitest run ${testTarget} --color --passWithNoTests --allowOnly`;
    } else if (project.isBunAvailable) {
      return `bun test ${testTarget}`;
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

function buildPlaywrightCommand(playwrightArgs: string, targets: TestArgv['targets']): string {
  const base = 'BUN playwright';
  const target = targets?.join(' ') || 'test/e2e/';
  if (!playwrightArgs.startsWith('test ') || !targets?.length) {
    return `${base} ${playwrightArgs}`;
  }

  const rest = playwrightArgs.slice('test '.length).trim();
  const parts = rest.length > 0 ? rest.split(/\s+/) : [];
  if (!parts[0] || parts[0].startsWith('-')) {
    parts.unshift(target);
  } else {
    parts[0] = target;
  }
  return `${base} test ${parts.join(' ')}`;
}
