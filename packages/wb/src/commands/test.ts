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
import { runWithSpawn } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

import { httpServerPackages } from './httpServerPackages.js';

const builder = {
  e2e: {
    description:
      'Whether to run e2e tests. You may pass mode as argument: none | headless (default) | headless-dev | headed | headed-dev | docker | docker-debug | debug | generate | trace',
    type: 'string',
  },
  silent: {
    description: 'Reduce redundant outputs',
    type: 'boolean',
  },
  start: {
    description: 'Whether to run start tests',
    type: 'boolean',
  },
  unit: {
    description: 'Whether to run unit tests',
    type: 'boolean',
  },
  'unit-timeout': {
    description: 'Timeout for unit tests',
    type: 'number',
  },
  target: {
    description: 'Test target',
    type: 'string',
    alias: 't',
  },
} as const;

export type TestArgv = Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder & typeof scriptOptionsBuilder>>>;

export const testCommand: CommandModule<unknown, InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>> = {
  command: 'test',
  describe: 'Test project. If you pass no arguments, it will run all tests.',
  builder,
  async handler(argv) {
    await test(argv);
  },
};

export async function test(
  argv: ArgumentsCamelCase<InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>>
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

  const shouldRunAllTests = argv.e2e === undefined && argv.start === undefined && argv.unit === undefined;

  for (const project of projects.descendants) {
    const deps = project.packageJson.dependencies || {};
    const devDeps = project.packageJson.devDependencies || {};
    let scripts: BaseScripts;
    if (deps['blitz']) {
      scripts = blitzScripts;
    } else if (deps['next']) {
      scripts = nextScripts;
    } else if (devDeps['@remix-run/dev']) {
      scripts = remixScripts;
    } else if (httpServerPackages.some((p) => deps[p]) && !deps['firebase-functions']) {
      scripts = httpServerScripts;
    } else {
      scripts = plainAppScripts;
    }

    if (shouldRunAllTests) {
      argv = {
        ...argv,
        e2e:
          fs.existsSync(path.join(project.dirPath, 'test', 'e2e')) && !argv.target?.includes('/unit/')
            ? 'headless'
            : 'none',
        start: true,
        unit: fs.existsSync(path.join(project.dirPath, 'test', 'unit')) && !argv.target?.includes('/e2e/'),
      };
    }

    console.info(`Running "test" for ${project.name} ...`);

    const promises: Promise<unknown>[] = [];
    if (argv.unit) {
      promises.push(runWithSpawn(scripts.testUnit(project, argv), project, argv, { timeout: argv.unitTimeout }));
    }
    if (argv.start) {
      promises.push(runWithSpawn(scripts.testStart(project, argv), project, argv));
    }
    await Promise.all(promises);
    switch (argv.e2e) {
      case undefined:
      case 'none': {
        continue;
      }
      case '':
      case 'headless': {
        await runWithSpawn(scripts.testE2E(project, argv, {}), project, argv);
        continue;
      }
      case 'headless-dev': {
        await runWithSpawn(scripts.testE2EDev(project, argv, {}), project, argv);
        continue;
      }
      case 'docker': {
        await testOnDocker(project, argv, scripts);
        continue;
      }
      case 'docker-debug': {
        await testOnDocker(project, argv, scripts, `test ${argv.target || 'test/e2e/'} --debug`);
        continue;
      }
    }
    if (deps['blitz'] || deps['next'] || devDeps['@remix-run/dev']) {
      switch (argv.e2e) {
        case 'headed': {
          await runWithSpawn(
            scripts.testE2E(project, argv, { playwrightArgs: `test ${argv.target || 'test/e2e/'} --headed` }),
            project,
            argv
          );
          continue;
        }
        case 'headed-dev': {
          await runWithSpawn(
            scripts.testE2EDev(project, argv, { playwrightArgs: `test ${argv.target || 'test/e2e/'} --headed` }),
            project,
            argv
          );
          continue;
        }
        case 'debug': {
          await runWithSpawn(
            scripts.testE2E(project, argv, { playwrightArgs: `test ${argv.target || 'test/e2e/'} --debug` }),
            project,
            argv
          );
          continue;
        }
        case 'generate': {
          await runWithSpawn(
            scripts.testE2E(project, argv, { playwrightArgs: 'codegen http://localhost:8080' }),
            project,
            argv
          );
          continue;
        }
        case 'trace': {
          await runWithSpawn(`BUN playwright show-trace`, project, argv);
          continue;
        }
      }
    }
    throw new Error(`Unknown e2e mode: ${argv.e2e}`);
  }
}

async function testOnDocker(
  project: Project,
  argv: ArgumentsCamelCase<InferredOptionTypes<typeof builder>>,
  scripts: BaseScripts,
  playwrightArgs?: string
): Promise<void> {
  process.env.WB_DOCKER ||= '1';
  await runWithSpawn(`${scripts.buildDocker(project, 'test')}${toDevNull(argv)}`, project, argv);
  process.exitCode = await runWithSpawn(
    `${scripts.testE2E(project, argv, {
      playwrightArgs,
      startCommand: `${dockerScripts.stopAndStart(project, true)}${toDevNull(argv)}`,
    })}`,
    project,
    argv,
    { exitIfFailed: false }
  );
  await runWithSpawn(dockerScripts.stop(project), project, argv);
}
