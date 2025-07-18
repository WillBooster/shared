import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';
import { toDevNull } from '../builder.js';
import { dockerScripts } from '../dockerScripts.js';

export interface TestE2EDevOptions {
  // '--e2e generate' calls 'codegen http://localhost:8080'
  playwrightArgs?: string;
  startCommand?: string;
}

export interface TestE2EOptions extends TestE2EDevOptions {
  prismaDirectory?: string;
}

/**
 * A collection of scripts for executing an app.
 * Note that YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
export abstract class BaseScripts {
  private readonly defaultPort;

  protected constructor(defaultPort = Number(process.env.PORT) || 3000) {
    this.defaultPort = defaultPort;
  }

  buildDocker(project: Project, version = 'development'): string {
    return dockerScripts.buildDevImage(project, version);
  }

  abstract start(project: Project, argv: ScriptArgv): string;

  abstract startProduction(project: Project, argv: ScriptArgv, port: number): string;

  startDocker(project: Project, argv: ScriptArgv): string {
    return `${this.buildDocker(project)}${toDevNull(argv)}
      && YARN concurrently --raw --kill-others-on-fail
        "${dockerScripts.stopAndStart(
          project,
          false,
          argv.normalizedDockerOptionsText ?? '',
          argv.normalizedArgsText ?? ''
        )}"
        "${this.waitAndOpenApp(project, argv, 8080)}"`;
  }

  testE2E(
    project: Project,
    argv: TestArgv,
    { playwrightArgs = 'test test/e2e/', prismaDirectory, startCommand }: TestE2EOptions
  ): string {
    const env = project.env.WB_ENV;
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    return `WB_ENV=${env} NEXT_PUBLIC_WB_ENV=${env} APP_ENV=${env} PORT=8080 YARN concurrently --kill-others --raw --success first
      "rm -Rf ${prismaDirectory}/mount && ${startCommand} && exit 1"
      "wait-on -t 600000 -i 2000 http-get://127.0.0.1:8080
        && BUN playwright ${playwrightArgs === 'test test/e2e/' && argv.target ? playwrightArgs.replace('test/e2e/', argv.target) : playwrightArgs}${suffix}"`;
  }

  testE2EDev(
    project: Project,
    argv: TestArgv,
    { playwrightArgs = 'test test/e2e/', startCommand }: TestE2EDevOptions
  ): string {
    const env = project.env.WB_ENV;
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    return `WB_ENV=${env} NEXT_PUBLIC_WB_ENV=${env} APP_ENV=${env} PORT=8080 YARN concurrently --kill-others --raw --success first
      "${startCommand} && exit 1"
      "wait-on -t 600000 -i 2000 http-get://127.0.0.1:8080
        && BUN playwright ${playwrightArgs === 'test test/e2e/' && argv.target ? playwrightArgs.replace('test/e2e/', argv.target) : playwrightArgs}${suffix}"`;
  }

  abstract testStart(project: Project, argv: ScriptArgv): string;

  testUnit(project: Project, argv: TestArgv): string {
    if (project.hasVitest) {
      // Since this command is referred from other commands, we have to use "vitest run" (non-interactive mode).
      return `WB_ENV=${project.env.WB_ENV} YARN vitest run ${argv.target || 'test/unit/'} --color --passWithNoTests --allowOnly`;
    } else if (project.isBunAvailable) {
      return `WB_ENV=${project.env.WB_ENV} bun test ${argv.target || 'test/unit/'}`;
    }
    return 'echo "No tests."';
  }

  protected waitApp(project: Project, argv: ScriptArgv, port = this.defaultPort): string {
    return `wait-on -t 10000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 500 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 1000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 2000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 20000 -i 4000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 60000 -i 5000 http-get://127.0.0.1:${port}`;
  }

  protected waitAndOpenApp(project: Project, argv: ScriptArgv, port = this.defaultPort): string {
    return `${this.waitApp(
      project,
      argv,
      port
    )} || wait-on http-get://127.0.0.1:${port} && open-cli http://\${HOST:-localhost}:${port}`;
  }
}
