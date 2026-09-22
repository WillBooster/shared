import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import { buildEnvReaderOptionArgs } from '../../sharedOptionsBuilder.js';
import { ensurePort } from '../../utils/port.js';
import { buildShellCommand } from '../../utils/shell.js';
import type { ScriptArgv } from '../builder.js';

import { BaseScripts, buildE2EReadinessCommand, type TestE2EOptions } from './baseScripts.js';
import { adaptForwardedArgsForUnitRunner, validateUnitRunnerTestSelection } from './unitRunnerArgs.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
export class HttpServerScripts extends BaseScripts {
  constructor() {
    super(false);
  }

  override validateTestSelection = validateUnitRunnerTestSelection;

  protected override startDevProtected(_: Project, argv: ScriptArgv): string {
    return `YARN build-ts run ${argv.watch ? '--watch' : ''} src/index.ts -- ${argv.normalizedArgsText ?? ''}`;
  }

  override async testE2EProtected(
    project: Project,
    argv: TestArgv,
    startCommand: string,
    options: TestE2EOptions = {},
    isDocker = false
  ): Promise<string> {
    if (project.hasPlaywrightConfig) {
      return super.testE2EProtected(project, argv, startCommand, options, isDocker);
    }

    this.validateTestSelection(project, argv, options.forwardedPlaywrightArgs ?? []);
    const port = await ensurePort(project);
    const forwarded = adaptForwardedArgsForUnitRunner(options.forwardedPlaywrightArgs ?? []);
    const supported = forwarded.unsupportedOption === undefined;
    const suffix = this.additionalE2ECommand(project, argv, supported ? options.forwardedPlaywrightArgs : []);
    const targets = [...(argv.targets?.map(String) ?? []), ...(supported ? forwarded.targets : [])];
    const normalizedTargets = targets.length > 0 ? targets : ['test/e2e/'];
    let testCommand = this.buildUnitRunnerCommand(project, { ...argv, targets: normalizedTargets });
    if (supported && forwarded.flags.length > 0) testCommand += ` ${buildShellCommand(forwarded.flags)}`;
    return buildShellCommand([
      'YARN',
      'wb',
      'concurrently',
      ...buildEnvReaderOptionArgs(argv),
      '--kill-others',
      '--success',
      'first',
      `${startCommand} && exit 1`,
      `${buildE2EReadinessCommand(port, isDocker)} && ${testCommand}${suffix}`,
    ]);
  }
}

export const httpServerScripts = new HttpServerScripts();
