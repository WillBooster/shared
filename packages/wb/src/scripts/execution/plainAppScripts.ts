import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';
import { SERVER_LOG_FILE } from '../../utils/log.js';
import { buildShellCommand } from '../../utils/shell.js';
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
  // A plain project's e2e tests need credentials or paid services (e.g. real LLM calls), which CI
  // does not provide; a Playwright fixture with its own `webServer` is self-contained and CI-safe.
  override runsE2eOnCi(project: Project): boolean {
    return project.hasPlaywrightWebServerConfig;
  }
  override usesUnitRunnerForE2e(project: Project): boolean {
    return !project.hasPlaywrightConfig;
  }

  // A library has no server of its own, but it may ship a self-contained Playwright fixture whose
  // config builds and starts the app under test via a `webServer` block (e.g. a Next.js fixture that
  // verifies the published package imports cleanly). Run Playwright directly in that case — including
  // on CI, where Playwright's own `webServer` starts the fixture. Otherwise run `test/e2e/` with the
  // unit-test runner: CLI and library projects keep slow tests hitting real external dependencies
  // there, and without this path they would never run.
  private async testE2EWithoutServer(project: Project, argv: TestArgv, options: TestE2EOptions): Promise<string> {
    if (project.hasPlaywrightWebServerConfig) {
      return this.buildPlaywrightOnlyCommand(project, argv, options);
    }
    // A Playwright config without `webServer` expects an externally managed server (the shape wbfy's
    // playwrightConfig fixer documents); its specs cannot run under the unit runner.
    if (project.hasPlaywrightConfig) {
      return `echo 'do nothing.'`;
    }
    // `wb test -- <args>` enables the e2e phase, so dropping the forwarded args here would run the
    // whole (potentially paid) suite unfiltered; translate what the unit runners understand.
    const forwarded = adaptForwardedArgsForUnitRunner(options.forwardedPlaywrightArgs ?? []);
    if (forwarded.unsupportedOption !== undefined) {
      return buildShellCommand([
        'echo',
        `Skipping test/e2e/ (cannot forward the Playwright arg to the unit-test runner: ${forwarded.unsupportedOption}).`,
      ]);
    }
    const explicitTargets = [...(argv.targets ?? []), ...forwarded.targets];
    const targets = explicitTargets.length > 0 ? explicitTargets : ['test/e2e/'];
    const unitRunnerCommand = this.testUnit(project, { ...argv, targets });
    return forwarded.flags.length > 0
      ? `${unitRunnerCommand} ${buildShellCommand(forwarded.flags)}`
      : unitRunnerCommand;
  }
  override testStart(): Promise<string> {
    return Promise.resolve(`echo 'do nothing.'`);
  }
}

export const plainAppScripts = new PlainAppScripts();

const NAME_FILTER_OPTION_REGEXP = /^(?:-t|-g|--grep|--test-name-pattern)(?:=(?<value>.*))?$/;

/**
 * Splits `wb test -- <args>` (documented as Playwright flags) into what `bun test`/vitest accept:
 * bare paths become positional targets, and the name-filter flags both runners share are translated
 * to a single `-t=<pattern>` token (`=`-joined so a pattern starting with `-` is not parsed as an
 * option; last filter wins, matching Playwright's CLI). Any other option is reported instead of
 * being spliced into the runner command — vitest aborts on unknown or duplicated options, which
 * would kill the whole monorepo test run.
 */
function adaptForwardedArgsForUnitRunner(args: string[]): {
  targets: string[];
  flags: string[];
  unsupportedOption?: string;
} {
  const targets: string[] = [];
  let nameFilter: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === '--') {
      targets.push(...args.slice(index + 1));
      break;
    }
    const filterMatch = NAME_FILTER_OPTION_REGEXP.exec(arg);
    if (filterMatch) {
      const value = filterMatch.groups?.value ?? args[++index];
      // A missing or empty filter value (e.g. `--grep "$UNSET_VAR"`) must not fall through to an
      // unfiltered run of the whole (potentially paid) suite — `-t ''` matches every test.
      if (!value) return { targets, flags: [], unsupportedOption: arg };
      nameFilter = value;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      return { targets, flags: [], unsupportedOption: arg };
    }
    targets.push(arg);
  }
  return { targets, flags: nameFilter === undefined ? [] : [`-t=${nameFilter}`] };
}
