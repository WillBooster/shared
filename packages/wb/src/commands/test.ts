import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import { distance } from 'fastest-levenshtein';
import type { Argv, ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
import type { scriptOptionsBuilder } from '../scripts/builder.js';
import { toDevNull } from '../scripts/builder.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import type { BaseScripts } from '../scripts/execution/baseScripts.js';
import { findExplicitPlaywrightTargetIndexes } from '../scripts/execution/baseScripts.js';
import { httpServerScripts } from '../scripts/execution/httpServerScripts.js';
import { nextScripts } from '../scripts/execution/nextScripts.js';
import { plainAppScripts } from '../scripts/execution/plainAppScripts.js';
import { vinextScripts } from '../scripts/execution/vinextScripts.js';
import { viteScripts } from '../scripts/execution/viteScripts.js';
import { workersScripts } from '../scripts/execution/workersScripts.js';
import { runWithSpawn } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { findWranglerConfigPath } from '../utils/wrangler.js';

import { httpServerPackages } from './httpServerPackages.js';

const ANSI_ESCAPE_CODE_REGEXP = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const SIMILAR_TEST_OUTPUT_LOOKBACK_LINE_COUNT = 200;
const SIMILAR_TEST_OUTPUT_DISTANCE_RATIO = 0.05;

const builder = {
  e2e: {
    description: 'How to run E2E tests',
    type: 'string',
    choices: [
      'headless',
      'headless-dev',
      'headed',
      'headed-dev',
      'docker',
      'docker-debug',
      'debug',
      'generate',
      'trace',
    ],
    default: 'headless',
  },
  silent: {
    description: 'Reduce redundant outputs',
    type: 'boolean',
  },
  bail: {
    description: 'Stop tests after the first failure',
    type: 'boolean',
  },
  'unit-timeout': {
    description: 'Timeout for unit tests',
    type: 'number',
  },
} as const;

const argumentsBuilder = {
  targets: {
    array: true,
    description: 'Unit or E2E test target paths',
    type: 'string',
  },
} as const;

type TestCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder & typeof argumentsBuilder>;

export type TestArgv = Partial<
  ArgumentsCamelCase<InferredOptionTypes<typeof builder & typeof scriptOptionsBuilder & typeof argumentsBuilder>>
>;

export type TestCommandArgv = ArgumentsCamelCase<TestCommandOptions> & { '--'?: string[] };

export interface TestRunOptions {
  exitIfFailed?: boolean;
}

export const testCommand: CommandModule<unknown, TestCommandOptions> = {
  command: 'test [targets...]',
  describe:
    "Test project. If you pass no arguments, it will run all tests. Use '--' to stop wb option parsing and forward the remaining flags to Playwright. Example: wb test -- --grep 'uploaded image asset'",
  builder: (yargs: Argv<unknown>): Argv<TestCommandOptions> =>
    yargs
      .parserConfiguration({ 'populate--': true })
      .options(builder)
      .positional('targets', argumentsBuilder.targets) as Argv<TestCommandOptions>,
  async handler(argv) {
    process.exit(await test(argv as TestCommandArgv));
  },
};

export async function test(argv: TestCommandArgv, options: TestRunOptions = {}): Promise<number> {
  const testArgv = withDefaultTestCascadeEnv(argv);
  const projects = await findDescendantProjects(testArgv);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    return 1;
  }

  // Get test targets from positional arguments
  const testTargets = (testArgv.targets ?? []) as string[];
  const forwardedPlaywrightArgs = testArgv['--'] ?? [];
  const { shouldRunE2e, shouldRunUnit } = resolveTestExecutionTargets(testTargets, forwardedPlaywrightArgs);

  for (const project of projects.descendants) {
    // Resolve the environment eagerly: withDefaultTestCascadeEnv forces the test cascade and
    // Project.completeAndValidateWbEnv falls back WB_ENV to that mode — but the env getter is
    // lazy, so a project with no runnable tests would otherwise skip the validation entirely.
    void project.env;

    const deps = project.packageJson.dependencies ?? {};
    const devDeps = project.packageJson.devDependencies ?? {};
    let scripts: BaseScripts;
    if (deps.vinext || devDeps.vinext) {
      // vinext apps also depend on next, so this check must come first.
      scripts = vinextScripts;
    } else if (deps.next) {
      scripts = nextScripts;
    } else if (devDeps.vite) {
      scripts = viteScripts;
    } else if (findWranglerConfigPath(project)) {
      // Plain Cloudflare Workers app; vinext apps are detected above.
      scripts = workersScripts;
    } else if (httpServerPackages.some((p) => deps[p]) && !deps['firebase-functions']) {
      scripts = httpServerScripts;
    } else {
      scripts = plainAppScripts;
    }

    console.info(`Running "test" for ${project.name} ...`);

    const structureViolations = findTestStructureViolations(project);
    if (structureViolations.length > 0) {
      printTestStructureViolations(project.name, structureViolations);
      return 1;
    }

    // Run unit tests if needed
    const defaultUnitTargets = getDefaultUnitTargets(project);
    const explicitUnitTargets = testTargets.filter((target) => !isE2eTarget(target));
    const unitTargets = explicitUnitTargets.length > 0 ? explicitUnitTargets : defaultUnitTargets;
    if (shouldRunUnit && unitTargets !== false) {
      const unitArgv = { ...testArgv, targets: unitTargets };
      const exitCode = await runUnitTestCommand(scripts.testUnit(project, unitArgv), project, testArgv, {
        exitIfFailed: options.exitIfFailed,
        timeout: testArgv.unitTimeout,
      });
      if (exitCode !== 0) {
        return exitCode;
      }
    }
    // Skip e2e tests if not needed or no e2e directory exists
    if (!shouldRunE2e || !fs.existsSync(path.join(project.dirPath, 'test', 'e2e'))) {
      continue;
    }

    // Get e2e targets for this project
    const e2eTargets = testTargets.filter((target) => isE2eTarget(target));
    const e2eArgv = { ...testArgv, targets: e2eTargets.length > 0 ? e2eTargets : undefined };

    switch (testArgv.e2e) {
      case 'headless': {
        const exitCode = await runTestCommand(
          await scripts.testE2EProduction(project, e2eArgv, {
            playwrightArgs: buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs),
            forwardedPlaywrightArgs,
          }),
          project,
          testArgv,
          { exitIfFailed: options.exitIfFailed }
        );
        if (exitCode !== 0) return exitCode;
        continue;
      }
      case 'headless-dev': {
        const exitCode = await runTestCommand(
          await scripts.testE2EDev(project, e2eArgv, {
            playwrightArgs: buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs),
            forwardedPlaywrightArgs,
          }),
          project,
          testArgv,
          { exitIfFailed: options.exitIfFailed }
        );
        if (exitCode !== 0) return exitCode;
        continue;
      }
      case 'docker': {
        const exitCode = await testOnDocker(
          project,
          e2eArgv,
          scripts,
          buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs),
          forwardedPlaywrightArgs,
          options
        );
        if (exitCode !== 0) return exitCode;
        continue;
      }
      case 'docker-debug': {
        const exitCode = await testOnDocker(
          project,
          e2eArgv,
          scripts,
          buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs, ['--debug']),
          forwardedPlaywrightArgs,
          options
        );
        if (exitCode !== 0) return exitCode;
        continue;
      }
    }
    if (deps.next || devDeps.vite) {
      switch (testArgv.e2e) {
        case 'headed': {
          const exitCode = await runTestCommand(
            await scripts.testE2EProduction(project, e2eArgv, {
              playwrightArgs: buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs, ['--headed']),
              forwardedPlaywrightArgs,
            }),
            project,
            testArgv,
            { exitIfFailed: options.exitIfFailed }
          );
          if (exitCode !== 0) return exitCode;
          break;
        }
        case 'headed-dev': {
          const exitCode = await runTestCommand(
            await scripts.testE2EDev(project, e2eArgv, {
              playwrightArgs: buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs, ['--headed']),
              forwardedPlaywrightArgs,
            }),
            project,
            testArgv,
            { exitIfFailed: options.exitIfFailed }
          );
          if (exitCode !== 0) return exitCode;
          break;
        }
        case 'debug': {
          const exitCode = await runTestCommand(
            await scripts.testE2EProduction(project, e2eArgv, {
              playwrightArgs: buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs, ['--debug']),
              forwardedPlaywrightArgs,
            }),
            project,
            testArgv,
            { exitIfFailed: options.exitIfFailed }
          );
          if (exitCode !== 0) return exitCode;
          break;
        }
        case 'generate': {
          const exitCode = await runTestCommand(
            await scripts.testE2EProduction(project, e2eArgv, {
              playwrightArgs: ['codegen', `http://localhost:${project.env.PORT}`],
            }),
            project,
            testArgv,
            { exitIfFailed: options.exitIfFailed }
          );
          if (exitCode !== 0) return exitCode;
          break;
        }
        case 'trace': {
          const exitCode = await runTestCommand(`BUN playwright show-trace`, project, testArgv, {
            exitIfFailed: options.exitIfFailed,
          });
          if (exitCode !== 0) return exitCode;
          break;
        }
      }
    }
  }
  return 0;
}

const ALLOWED_TEST_DIRECTORY_NAMES = new Set(['unit', 'e2e', 'debug', 'helpers', 'fixtures']);
const RUNNABLE_TEST_DIRECTORY_NAMES = new Set(['unit', 'e2e', 'debug']);
const TEST_FILE_NAME_REGEXP = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Enforces the test-layout convention with no fallback: `test/` may contain only the `unit`, `e2e`,
 * `debug`, `helpers`, and `fixtures` directories, and test files may exist only under `test/unit/`,
 * `test/e2e/`, and `test/debug/` — anywhere else in the project (e.g. `test/helpers/`, `src/`, or the
 * project root), wb would silently skip them. A project's own Playwright config also requires
 * `test/e2e` for the same reason. `test/fixtures/` is exempt from the test-file check because
 * fixtures may contain test files as data.
 */
export function findTestStructureViolations(project: Pick<Project, 'dirPath' | 'packageJson'>): string[] {
  const violations: string[] = [];
  const testDirPath = path.join(project.dirPath, 'test');
  if (fs.existsSync(testDirPath)) {
    for (const entry of fs.readdirSync(testDirPath, { withFileTypes: true })) {
      // OS and editor artifacts such as .DS_Store are environment noise, not layout mistakes.
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() || !ALLOWED_TEST_DIRECTORY_NAMES.has(entry.name)) {
        violations.push(`test/${entry.name}`);
      }
    }
  }
  collectStrayTestFiles(project.dirPath, '', violations);
  // Only a project's OWN Playwright config counts: a workspace root legitimately shares a root-level
  // playwright.config.ts while keeping e2e specs in a single app package.
  if (
    !project.packageJson.workspaces &&
    fs.existsSync(path.join(project.dirPath, 'playwright.config.ts')) &&
    !fs.existsSync(path.join(testDirPath, 'e2e'))
  ) {
    violations.push('playwright.config.ts');
  }
  // A test file directly under test/ is reported by both the top-level check and the stray-file walk.
  return [...new Set(violations)];
}

function collectStrayTestFiles(projectDirPath: string, relativeDirPath: string, violations: string[]): void {
  for (const entry of fs.readdirSync(path.join(projectDirPath, relativeDirPath), { withFileTypes: true })) {
    // Hidden entries (.git, .tmp, .next, ...) and dependencies are not project-authored test locations:
    // the convention places tests only under test/, so a test file in a hidden directory (e.g.
    // .storybook) is outside the input contract, and enumerating environmental hidden directories
    // instead would false-positive on any unlisted generated one (.turbo, .wrangler, ...). Visible
    // build outputs such as dist/ are deliberately NOT skipped: wbfy-managed builds never emit
    // test-pattern files there, so any match is an authored file worth flagging.
    // Symlinks fail `isDirectory()` on a Dirent, so cycles are impossible.
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const relativePath = relativeDirPath ? `${relativeDirPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // test/unit, test/e2e, and test/debug hold the runnable tests; test/fixtures may contain
      // test files as data.
      if (relativeDirPath === 'test' && (RUNNABLE_TEST_DIRECTORY_NAMES.has(entry.name) || entry.name === 'fixtures')) {
        continue;
      }
      // A nested package (e.g. a workspace member) is validated as its own project.
      if (fs.existsSync(path.join(projectDirPath, relativePath, 'package.json'))) continue;
      collectStrayTestFiles(projectDirPath, relativePath, violations);
    } else if (TEST_FILE_NAME_REGEXP.test(entry.name)) {
      violations.push(relativePath);
    }
  }
}

export function printTestStructureViolations(projectName: string, violations: string[]): void {
  console.error(
    chalk.red(
      `Invalid test layout in ${projectName}. test/ may contain only the unit, e2e, debug, helpers, and fixtures directories, test files may exist only under test/unit/, test/e2e/, and test/debug/, and a Playwright config requires test/e2e/:\n` +
        violations.map((violation) => `  ${violation}`).join('\n')
    )
  );
}

export function withDefaultTestCascadeEnv(argv: TestCommandArgv): TestCommandArgv {
  if (argv.cascadeEnv || argv.cascadeNodeEnv || argv.autoCascadeEnv === false) {
    // Explicit env flags keep their profile-selection semantics, but the spawned tests must still
    // run as `test` when the selected profile defines no WB_ENV (the pre-15 `||= 'test'` behavior).
    return { ...argv, commandDefaultWbEnv: 'test' };
  }
  return { ...argv, cascadeEnv: 'test' };
}

/**
 * Unit tests live only under `test/unit/`; `test/debug/` runs only when explicitly targeted. Both
 * vitest and `bun test` treat a bare `test` as a filename filter, which also matches e.g.
 * `src/foo.test.ts`, so the trailing slash that limits the target to the directory is required.
 */
export function getDefaultUnitTargets(project: Pick<Project, 'dirPath'>): string[] | false {
  return fs.existsSync(path.join(project.dirPath, 'test', 'unit')) ? ['./test/unit/'] : false;
}

async function testOnDocker(
  project: Project,
  argv: ArgumentsCamelCase<InferredOptionTypes<typeof builder & typeof argumentsBuilder>>,
  scripts: BaseScripts,
  playwrightArgs?: string[],
  forwardedPlaywrightArgs?: string[],
  options: TestRunOptions = {}
): Promise<number> {
  project.env.WB_DOCKER ||= '1';
  const buildExitCode = await runWithSpawn(`${scripts.buildDocker(project, 'test')}${toDevNull(argv)}`, project, argv, {
    exitIfFailed: options.exitIfFailed,
  });
  if (buildExitCode !== 0) {
    return buildExitCode;
  }
  const testExitCode = await runTestCommand(
    await scripts.testE2EDocker(project, argv, {
      playwrightArgs,
      forwardedPlaywrightArgs,
    }),
    project,
    argv,
    { exitIfFailed: false }
  );
  const stopExitCode = await runWithSpawn(dockerScripts.stop(project), project, argv, {
    exitIfFailed: options.exitIfFailed,
  });
  if (testExitCode !== 0) {
    return testExitCode;
  }
  return stopExitCode;
}

function runTestCommand(
  script: string,
  project: Project,
  argv: Parameters<typeof runWithSpawn>[2],
  options: Parameters<typeof runWithSpawn>[3] = {}
): Promise<number> {
  return runWithSpawn(script, project, argv, {
    ...options,
    processSilentOutput: dedupeNoisyTestOutput,
  });
}

function runUnitTestCommand(
  script: string,
  project: Project,
  argv: Parameters<typeof runWithSpawn>[2],
  options: Parameters<typeof runWithSpawn>[3] = {}
): Promise<number> {
  return runWithSpawn(script, project, argv, {
    ...options,
    omitSilentStart: true,
    printSilentOutputOnFailureOnly: true,
    silentProgressIntervalMs: 10_000,
    silentSuccessMessage: 'Unit tests passed.',
  });
}

function dedupeNoisyTestOutput(output: string): string {
  const recentPrintedLines: string[] = [];
  const recentPrintedLineSet = new Set<string>();
  const dedupedLines: string[] = [];
  for (const line of iterateLines(output)) {
    const normalizedLine = normalizeLineForSimilarity(line);
    if (recentPrintedLineSet.has(normalizedLine)) continue;
    if (recentPrintedLines.some((printedLine) => areLinesSimilar(printedLine, normalizedLine))) continue;

    pushRecentPrintedLine(recentPrintedLines, recentPrintedLineSet, normalizedLine);
    dedupedLines.push(line);
  }
  return dedupedLines.join('\n');
}

function* iterateLines(output: string): Generator<string> {
  let lineStartIndex = 0;
  while (lineStartIndex <= output.length) {
    const lineEndIndex = output.indexOf('\n', lineStartIndex);
    if (lineEndIndex === -1) {
      yield output.slice(lineStartIndex);
      return;
    }

    yield output.slice(lineStartIndex, lineEndIndex);
    lineStartIndex = lineEndIndex + 1;
  }
}

function pushRecentPrintedLine(lines: string[], lineSet: Set<string>, line: string): void {
  lines.push(line);
  lineSet.add(line);
  if (lines.length <= SIMILAR_TEST_OUTPUT_LOOKBACK_LINE_COUNT) return;

  const removedLine = lines.shift();
  if (removedLine !== undefined) {
    lineSet.delete(removedLine);
  }
}

function normalizeLineForSimilarity(line: string): string {
  return line
    .replaceAll(ANSI_ESCAPE_CODE_REGEXP, '')
    .trim()
    .replaceAll(/^(?:\[[^\]]+\]\s*)+/g, '')
    .replaceAll(/\(node:\d+\)/g, '(node:<number>)')
    .replaceAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<timestamp>')
    .replaceAll(/([?&]cache=)\d+/g, '$1<number>');
}

function areLinesSimilar(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return true;
  if (Math.abs(a.length - b.length) > maxLength * SIMILAR_TEST_OUTPUT_DISTANCE_RATIO) return false;

  return distance(a, b) / maxLength <= SIMILAR_TEST_OUTPUT_DISTANCE_RATIO;
}

export function buildPlaywrightArgsForE2E(
  e2eTargets: string[],
  forwardedPlaywrightArgs: string[] = [],
  additionalArgs: string[] = []
): string[] {
  const hasForwardedPlaywrightTargets = findExplicitPlaywrightTargetIndexes(forwardedPlaywrightArgs).length > 0;
  return ['test', ...(e2eTargets.length > 0 || hasForwardedPlaywrightTargets ? [] : ['test/e2e/']), ...additionalArgs];
}

// Match the test/e2e path segment, not the '/e2e' substring: a unit target such as
// test/unit/e2eConfig.test.ts must not be classified as an e2e target.
const E2E_TARGET_REGEXP = /(?:^|\/)test\/e2e(?:\/|$)/;

export function isE2eTarget(target: string): boolean {
  return E2E_TARGET_REGEXP.test(target);
}

export function resolveTestExecutionTargets(
  testTargets: string[],
  forwardedPlaywrightArgs: string[] = []
): { shouldRunUnit: boolean; shouldRunE2e: boolean } {
  const hasE2eTargets = testTargets.some((target) => isE2eTarget(target));
  // Non-e2e targets (test/unit/ and test/debug/) run through the unit-test runner.
  const hasUnitTargets = testTargets.some((target) => !isE2eTarget(target));
  const shouldRunAllTests = testTargets.length === 0 && forwardedPlaywrightArgs.length === 0;

  return {
    shouldRunUnit: shouldRunAllTests || hasUnitTargets,
    shouldRunE2e: shouldRunAllTests || hasE2eTargets || forwardedPlaywrightArgs.length > 0,
  };
}
