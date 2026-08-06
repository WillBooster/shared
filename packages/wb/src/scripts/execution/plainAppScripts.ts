import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import { SERVER_LOG_FILE } from '../../utils/log.js';
import type { ScriptArgv } from '../builder.js';
import { dockerScripts } from '../dockerScripts.js';

import type { TestE2EOptions } from './baseScripts.js';
import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class PlainAppScripts extends BaseScripts {
  constructor() {
    super(false);
  }

  protected startDevProtected(_1: Project, _2: ScriptArgv): string {
    throw new Error('This method should not be called.');
  }

  override startDev(_: Project, argv: ScriptArgv): Promise<string> {
    return Promise.resolve(
      `YARN build-ts run ${argv.watch ? '--watch' : ''} src/index.ts -- ${argv.normalizedArgsText ?? ''}`
    );
  }
  override startProduction(project: Project, argv: ScriptArgv): Promise<string> {
    return Promise.resolve(
      `${project.buildCommand} && ${project.isBunAvailable ? 'bun run' : 'node'} dist/index.js ${argv.normalizedArgsText ?? ''} | tee ${SERVER_LOG_FILE}`
    );
  }
  override startTest(): Promise<string> {
    return Promise.resolve(`echo 'do nothing.'`);
  }
  override startDocker(project: Project, argv: ScriptArgv): Promise<string> {
    return Promise.resolve(
      `${this.buildDocker(project, 'development')} && ${dockerScripts.stopAndStart(
        project,
        argv.normalizedDockerOptionsText ?? '',
        argv.normalizedArgsText ?? ''
      )}`
    );
  }

  override testE2EDev(project: Project, argv: TestArgv, options: TestE2EOptions): Promise<string> {
    return this.testE2EWithoutServer(project, argv, options);
  }
  override testE2EProduction(project: Project, argv: TestArgv, options: TestE2EOptions): Promise<string> {
    return this.testE2EWithoutServer(project, argv, options);
  }
  override testE2EDocker(): Promise<string> {
    return Promise.resolve(`echo 'do nothing.'`);
  }
  /**
   * A plain project's e2e tests need credentials or paid services (e.g. real LLM calls), which CI
   * does not provide; a Playwright fixture with its own `webServer` is self-contained and CI-safe.
   */
  override runsE2eOnCi(project: Project): boolean {
    return project.hasPlaywrightWebServerConfig;
  }

  /**
   * A library has no server of its own, but it may ship a self-contained Playwright fixture whose
   * config builds and starts the app under test via a `webServer` block (e.g. a Next.js fixture that
   * verifies the published package imports cleanly). Run Playwright directly in that case — including
   * on CI, where Playwright's own `webServer` starts the fixture. Otherwise run `test/e2e/` with the
   * unit-test runner: CLI and library projects keep slow tests hitting real external dependencies
   * there, and without this path they would never run.
   */
  private testE2EWithoutServer(project: Project, argv: TestArgv, options: TestE2EOptions): Promise<string> {
    if (project.hasPlaywrightWebServerConfig) {
      return Promise.resolve(this.buildPlaywrightOnlyCommand(project, argv, options));
    }
    const targets = argv.targets?.length ? argv.targets : ['test/e2e/'];
    return Promise.resolve(this.testUnit(project, { ...argv, targets }));
  }
  override testStart(): Promise<string> {
    return Promise.resolve(`echo 'do nothing.'`);
  }
}

export const plainAppScripts = new PlainAppScripts();
