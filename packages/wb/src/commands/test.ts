import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
import type { scriptOptionsBuilder } from '../scripts/builder.js';
import { toDevNull } from '../scripts/builder.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import type { BaseScripts } from '../scripts/execution/baseScripts.js';
import { blitzScripts } from '../scripts/execution/blitzScripts.js';
import { httpServerScripts } from '../scripts/execution/httpServerScripts.js';
import { nextScripts } from '../scripts/execution/nextScripts.js';
import { plainAppScripts } from '../scripts/execution/plainAppScripts.js';
import { remixScripts } from '../scripts/execution/remixScripts.js';
import { viteScripts } from '../scripts/execution/viteScripts.js';
import { runWithSpawn } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

import { httpServerPackages } from './httpServerPackages.js';

const builder = {
  e2e: {
    description:
      'E2e test mode: headless (default) | headless-dev | headed | headed-dev | docker | docker-debug | debug | generate | trace',
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
    description: 'Test target paths',
    type: 'array',
  },
} as const;

export type TestArgv = Partial<
  ArgumentsCamelCase<InferredOptionTypes<typeof builder & typeof scriptOptionsBuilder & typeof argumentsBuilder>>
>;

export const testCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder & typeof argumentsBuilder>
> = {
  command: 'test [targets...]',
  describe: 'Test project. If you pass no arguments, it will run all tests.',
  builder: { ...builder, ...argumentsBuilder },
  async handler(argv) {
    await test(argv);
  },
};

export async function test(
  argv: ArgumentsCamelCase<InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder & typeof argumentsBuilder>>
): Promise<void> {
  const projects = await findDescendantProjects(argv);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    process.exit(1);
  }

  if (projects.descendants.length > 1) {
    // Disable interactive mode
    process.env.CI = '1';
  }
  process.env.FORCE_COLOR ||= '3';
  process.env.WB_ENV ||= 'test';

  // Get test targets from positional arguments
  const testTargets = (argv.targets ?? []) as string[];
  const shouldRunAllTests = testTargets.length === 0;

  // Detect test modes from target paths
  const hasE2eTargets = testTargets.some((target) => target.includes('/e2e'));
  const hasUnitTargets = testTargets.some((target) => target.includes('/unit'));
  const shouldRunUnit = shouldRunAllTests || hasUnitTargets;
  const shouldRunE2e = shouldRunAllTests || hasE2eTargets;

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
    } else if (devDeps.vite && devDeps['@playwright/test']) {
      scripts = viteScripts;
    } else if (httpServerPackages.some((p) => deps[p]) && !deps['firebase-functions']) {
      scripts = httpServerScripts;
    } else {
      scripts = plainAppScripts;
    }

    console.info(`Running "test" for ${project.name} ...`);

    // Run unit tests if needed
    if (shouldRunUnit && fs.existsSync(path.join(project.dirPath, 'test', 'unit'))) {
      const unitTargets = testTargets.filter((target) => target.includes('/unit'));
      const unitArgv = { ...argv, targets: unitTargets.length > 0 ? unitTargets : undefined };
      await runWithSpawn(scripts.testUnit(project, unitArgv), project, argv, { timeout: argv.unitTimeout });
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
        await runWithSpawn(await scripts.testE2EProduction(project, e2eArgv, {}), project, argv);
        continue;
      }
      case 'headless-dev': {
        await runWithSpawn(await scripts.testE2EDev(project, e2eArgv, {}), project, argv);
        continue;
      }
      case 'docker': {
        await testOnDocker(project, e2eArgv, scripts);
        continue;
      }
      case 'docker-debug': {
        const e2eTarget = e2eTargets.length > 0 ? e2eTargets.join(' ') : 'test/e2e/';
        await testOnDocker(project, e2eArgv, scripts, `test ${e2eTarget} --debug`);
        continue;
      }
    }
    if (deps.blitz || deps.next || devDeps['@remix-run/dev'] || (devDeps.vite && devDeps['@playwright/test'])) {
      const e2eTarget = e2eTargets.length > 0 ? e2eTargets.join(' ') : 'test/e2e/';
      switch (argv.e2e) {
        case 'headed': {
          await runWithSpawn(
            await scripts.testE2EProduction(project, e2eArgv, { playwrightArgs: `test ${e2eTarget} --headed` }),
            project,
            argv
          );
          break;
        }
        case 'headed-dev': {
          await runWithSpawn(
            await scripts.testE2EDev(project, e2eArgv, { playwrightArgs: `test ${e2eTarget} --headed` }),
            project,
            argv
          );
          break;
        }
        case 'debug': {
          await runWithSpawn(
            await scripts.testE2EProduction(project, e2eArgv, { playwrightArgs: `test ${e2eTarget} --debug` }),
            project,
            argv
          );
          break;
        }
        case 'generate': {
          await runWithSpawn(
            await scripts.testE2EProduction(project, e2eArgv, {
              playwrightArgs: `codegen http://localhost:${project.env.PORT}`,
            }),
            project,
            argv
          );
          break;
        }
        case 'trace': {
          await runWithSpawn(`BUN playwright show-trace`, project, argv);
          break;
        }
      }
    }
  }
}

async function testOnDocker(
  project: Project,
  argv: ArgumentsCamelCase<InferredOptionTypes<typeof builder & typeof argumentsBuilder>>,
  scripts: BaseScripts,
  playwrightArgs?: string
): Promise<void> {
  project.env.WB_DOCKER ||= '1';
  await runWithSpawn(`${scripts.buildDocker(project, 'test')}${toDevNull(argv)}`, project, argv);
  process.exitCode = await runWithSpawn(
    await scripts.testE2EDocker(project, argv, {
      playwrightArgs,
    }),
    project,
    argv,
    { exitIfFailed: false }
  );
  await runWithSpawn(dockerScripts.stop(project), project, argv);
}
