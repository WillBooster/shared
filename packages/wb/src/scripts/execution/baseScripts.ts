import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';
import { toDevNull } from '../builder.js';
import { dockerScripts } from '../dockerScripts.js';

export type TestE2EDevOptions = {
  // '--e2e generate' calls 'codegen http://localhost:8080'
  playwrightArgs?: string;
  startCommand?: string;
};

export type TestE2EOptions = {
  prismaDirectory?: string;
} & TestE2EDevOptions;

/**
 * A collection of scripts for executing an app.
 * Note that YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
export abstract class BaseScripts {
  buildDocker(project: Project, version = 'development'): string {
    return dockerScripts.buildDevImage(project, version);
  }

  abstract start(project: Project, argv: ScriptArgv): string;

  abstract startProduction(project: Project, argv: ScriptArgv, port: number): string;

  abstract startTest(project: Project, argv: ScriptArgv): string;

  startDocker(project: Project, argv: ScriptArgv): string {
    const port = Number(project.env.PORT) || 8080;
    return `${this.buildDocker(project)}${toDevNull(argv)}
      && YARN concurrently --raw --kill-others-on-fail
        "${dockerScripts.stopAndStart(
          project,
          false,
          argv.normalizedDockerOptionsText ?? '',
          argv.normalizedArgsText ?? ''
        )}"
        "${this.waitAndOpenApp(project, argv, port)}"`;
  }

  testE2E(
    project: Project,
    argv: TestArgv,
    { playwrightArgs = 'test test/e2e/', prismaDirectory, startCommand }: TestE2EOptions
  ): string {
    const env = project.env.WB_ENV;
    const port = project.env.PORT || '8080';
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    const testTarget = argv.targets && argv.targets.length > 0 ? argv.targets.join(' ') : 'test/e2e/';
    return `WB_ENV=${env} NEXT_PUBLIC_WB_ENV=${env} APP_ENV=${env} PORT=${port} YARN concurrently --kill-others --raw --success first
      "rm -Rf ${prismaDirectory}/mount && ${startCommand} && exit 1"
      "wait-on -t 600000 -i 2000 http-get://127.0.0.1:${port}
        && BUN playwright ${playwrightArgs === 'test test/e2e/' ? `test ${testTarget}` : playwrightArgs}${suffix}"`;
  }

  testE2EDev(
    project: Project,
    argv: TestArgv,
    { playwrightArgs = 'test test/e2e/', startCommand }: TestE2EDevOptions
  ): string {
    const env = project.env.WB_ENV;
    const port = project.env.PORT || '8080';
    const suffix = project.packageJson.scripts?.['test/e2e-additional'] ? ' && YARN test/e2e-additional' : '';
    const testTarget = argv.targets && argv.targets.length > 0 ? argv.targets.join(' ') : 'test/e2e/';
    return `WB_ENV=${env} NEXT_PUBLIC_WB_ENV=${env} APP_ENV=${env} PORT=${port} YARN concurrently --kill-others --raw --success first
      "${startCommand} && exit 1"
      "wait-on -t 600000 -i 2000 http-get://127.0.0.1:${port}
        && BUN playwright ${playwrightArgs === 'test test/e2e/' ? `test ${testTarget}` : playwrightArgs}${suffix}"`;
  }

  abstract testStart(project: Project, argv: ScriptArgv): Promise<string>;

  testUnit(project: Project, argv: TestArgv): string {
    const testTarget = argv.targets && argv.targets.length > 0 ? argv.targets.join(' ') : 'test/unit/';
    if (project.hasVitest) {
      // Since this command is referred from other commands, we have to use "vitest run" (non-interactive mode).
      return `WB_ENV=${project.env.WB_ENV} YARN vitest run ${testTarget} --color --passWithNoTests --allowOnly`;
    } else if (project.isBunAvailable) {
      return `WB_ENV=${project.env.WB_ENV} bun test ${testTarget}`;
    }
    return 'echo "No tests."';
  }

  protected waitApp(project: Project, argv: ScriptArgv, port = project.env.PORT || 3000): string {
    return `wait-on -t 10000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 500 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 1000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 2000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 20000 -i 4000 http-get://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 60000 -i 5000 http-get://127.0.0.1:${port}`;
  }

  protected waitAndOpenApp(project: Project, argv: ScriptArgv, port = project.env.PORT || 3000): string {
    return `${this.waitApp(
      project,
      argv,
      port
    )} || wait-on http-get://127.0.0.1:${port} && open-cli http://\${HOST:-localhost}:${port}`;
  }
}
