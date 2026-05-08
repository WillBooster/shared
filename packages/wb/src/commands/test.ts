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
import { blitzScripts } from '../scripts/execution/blitzScripts.js';
import { httpServerScripts } from '../scripts/execution/httpServerScripts.js';
import { nextScripts } from '../scripts/execution/nextScripts.js';
import { plainAppScripts } from '../scripts/execution/plainAppScripts.js';
import { remixScripts } from '../scripts/execution/remixScripts.js';
import { viteScripts } from '../scripts/execution/viteScripts.js';
import { runWithSpawn } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

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
    await test(argv as TestCommandArgv);
  },
};

export async function test(argv: TestCommandArgv): Promise<void> {
  const projects = await findDescendantProjects(argv);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    process.exit(1);
  }

  process.env.FORCE_COLOR ||= '3';
  delete process.env.NO_COLOR;
  process.env.WB_ENV ||= 'test';

  // Get test targets from positional arguments
  const testTargets = (argv.targets ?? []) as string[];
  const forwardedPlaywrightArgs = argv['--'] ?? [];
  const { shouldRunE2e, shouldRunUnit } = resolveTestExecutionTargets(testTargets, forwardedPlaywrightArgs);

  for (const project of projects.descendants) {
    const deps = project.packageJson.dependencies ?? {};
    const devDeps = project.packageJson.devDependencies ?? {};
    let scripts: BaseScripts;
    if (deps.blitz) {
      scripts = blitzScripts;
    } else if (deps.next) {
      scripts = nextScripts;
    } else if (devDeps['@remix-run/dev']) {
      scripts = remixScripts;
    } else if (devDeps.vite) {
      scripts = viteScripts;
    } else if (httpServerPackages.some((p) => deps[p]) && !deps['firebase-functions']) {
      scripts = httpServerScripts;
    } else {
      scripts = plainAppScripts;
    }

    console.info(`Running "test" for ${project.name} ...`);

    // Run unit tests if needed
    const defaultUnitTargets = getDefaultUnitTargets(project);
    if (shouldRunUnit && defaultUnitTargets !== false) {
      const unitTargets = testTargets.filter((target) => target.includes('/unit'));
      const targets =
        unitTargets.length > 0 ? unitTargets : defaultUnitTargets.length > 0 ? defaultUnitTargets : undefined;
      const unitArgv = { ...argv, targets };
      await runUnitTestCommand(scripts.testUnit(project, unitArgv), project, argv, { timeout: argv.unitTimeout });
    }
    // Skip e2e tests if not needed or no e2e directory exists
    if (!shouldRunE2e || !fs.existsSync(path.join(project.dirPath, 'test', 'e2e'))) {
      continue;
    }

    // Get e2e targets for this project
    const e2eTargets = testTargets.filter((target) => target.includes('/e2e'));
    const e2eArgv = { ...argv, targets: e2eTargets.length > 0 ? e2eTargets : undefined };

    switch (argv.e2e) {
      case 'headless': {
        await runTestCommand(
          await scripts.testE2EProduction(project, e2eArgv, {
            playwrightArgs: buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs),
            forwardedPlaywrightArgs,
          }),
          project,
          argv
        );
        continue;
      }
      case 'headless-dev': {
        await runTestCommand(
          await scripts.testE2EDev(project, e2eArgv, {
            playwrightArgs: buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs),
            forwardedPlaywrightArgs,
          }),
          project,
          argv
        );
        continue;
      }
      case 'docker': {
        await testOnDocker(
          project,
          e2eArgv,
          scripts,
          buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs),
          forwardedPlaywrightArgs
        );
        continue;
      }
      case 'docker-debug': {
        await testOnDocker(
          project,
          e2eArgv,
          scripts,
          buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs, ['--debug']),
          forwardedPlaywrightArgs
        );
        continue;
      }
    }
    if (deps.blitz || deps.next || devDeps['@remix-run/dev'] || devDeps.vite) {
      switch (argv.e2e) {
        case 'headed': {
          await runTestCommand(
            await scripts.testE2EProduction(project, e2eArgv, {
              playwrightArgs: buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs, ['--headed']),
              forwardedPlaywrightArgs,
            }),
            project,
            argv
          );
          break;
        }
        case 'headed-dev': {
          await runTestCommand(
            await scripts.testE2EDev(project, e2eArgv, {
              playwrightArgs: buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs, ['--headed']),
              forwardedPlaywrightArgs,
            }),
            project,
            argv
          );
          break;
        }
        case 'debug': {
          await runTestCommand(
            await scripts.testE2EProduction(project, e2eArgv, {
              playwrightArgs: buildPlaywrightArgsForE2E(e2eTargets, forwardedPlaywrightArgs, ['--debug']),
              forwardedPlaywrightArgs,
            }),
            project,
            argv
          );
          break;
        }
        case 'generate': {
          await runTestCommand(
            await scripts.testE2EProduction(project, e2eArgv, {
              playwrightArgs: ['codegen', `http://localhost:${project.env.PORT}`],
            }),
            project,
            argv
          );
          break;
        }
        case 'trace': {
          await runTestCommand(`BUN playwright show-trace`, project, argv);
          break;
        }
      }
    }
  }
}

function getDefaultUnitTargets(project: Project): string[] | false {
  if (fs.existsSync(path.join(project.dirPath, 'test', 'unit'))) {
    return [];
  }
  if (project.hasVitest && fs.existsSync(path.join(project.dirPath, 'test'))) {
    return fs.existsSync(path.join(project.dirPath, 'test', 'e2e')) ? ['test', '--exclude', 'test/e2e/**'] : ['test'];
  }
  return false;
}

async function testOnDocker(
  project: Project,
  argv: ArgumentsCamelCase<InferredOptionTypes<typeof builder & typeof argumentsBuilder>>,
  scripts: BaseScripts,
  playwrightArgs?: string[],
  forwardedPlaywrightArgs?: string[]
): Promise<void> {
  project.env.WB_DOCKER ||= '1';
  await runWithSpawn(`${scripts.buildDocker(project, 'test')}${toDevNull(argv)}`, project, argv);
  process.exitCode = await runTestCommand(
    await scripts.testE2EDocker(project, argv, {
      playwrightArgs,
      forwardedPlaywrightArgs,
    }),
    project,
    argv,
    { exitIfFailed: false }
  );
  await runWithSpawn(dockerScripts.stop(project), project, argv);
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

export function resolveTestExecutionTargets(
  testTargets: string[],
  forwardedPlaywrightArgs: string[] = []
): { shouldRunUnit: boolean; shouldRunE2e: boolean } {
  const hasE2eTargets = testTargets.some((target) => target.includes('/e2e'));
  const hasUnitTargets = testTargets.some((target) => target.includes('/unit'));
  const shouldRunAllTests = testTargets.length === 0 && forwardedPlaywrightArgs.length === 0;

  return {
    shouldRunUnit: shouldRunAllTests || hasUnitTargets,
    shouldRunE2e: shouldRunAllTests || hasE2eTargets || forwardedPlaywrightArgs.length > 0,
  };
}
