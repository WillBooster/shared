import path from 'node:path';

import { existsAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findAllProjects } from '../project.js';
import { promisePool } from '../promisePool.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import type { BaseExecutionScripts } from '../scripts/execution/baseExecutionScripts.js';
import { blitzScripts } from '../scripts/execution/blitzScripts.js';
import { httpServerScripts } from '../scripts/execution/httpServerScripts.js';
import { nextScripts } from '../scripts/execution/nextScripts.js';
import { plainAppScripts } from '../scripts/execution/plainAppScripts.js';
import { remixScripts } from '../scripts/execution/remixScripts.js';
import { runWithSpawn, runWithSpawnInParallel } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const builder = {
  ci: {
    description: 'Whether to run tests on CI',
    type: 'boolean',
  },
  e2e: {
    description:
      'Whether to run e2e tests. You may pass mode as argument: none | headless (default) | headless-dev | headed | headed-dev | docker | docker-debug | debug | generate | trace',
    type: 'string',
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
} as const;

export const testCommand: CommandModule<unknown, InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>> = {
  command: 'test',
  describe: 'Test project',
  builder,
  async handler(argv) {
    await test(argv);
  },
};

export async function test(
  argv: ArgumentsCamelCase<InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>>
): Promise<void> {
  const projects = await findAllProjects(argv);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    process.exit(1);
  }

  if (projects.all.length > 1) {
    // Disable interactive mode
    process.env.CI = '1';
  }
  process.env.FORCE_COLOR ||= '3';
  process.env.WB_ENV ||= 'test';

  for (const project of projects.all) {
    const deps = project.packageJson.dependencies || {};
    const devDeps = project.packageJson.devDependencies || {};
    let scripts: BaseExecutionScripts;
    if (deps['blitz']) {
      scripts = blitzScripts;
    } else if (deps['next']) {
      scripts = nextScripts;
    } else if (devDeps['@remix-run/dev']) {
      scripts = remixScripts;
    } else if ((deps['express'] || deps['fastify']) && !deps['firebase-functions']) {
      scripts = httpServerScripts;
    } else {
      scripts = plainAppScripts;
    }

    console.info(`Running "test" for ${project.name} ...`);

    const promises: Promise<unknown>[] = [];
    if (argv.ci) {
      const unitTestsExistPromise = existsAsync(path.join(project.dirPath, 'tests', 'unit'));
      const e2eTestsExistPromise = existsAsync(path.join(project.dirPath, 'tests', 'e2e'));

      await runWithSpawnInParallel(dockerScripts.stopAll(), project, argv);
      if (argv.unit !== false && (await unitTestsExistPromise)) {
        await runWithSpawnInParallel(scripts.testUnit(project, argv), project, argv, { timeout: argv.unitTimeout });
      }
      if (argv.start !== false) {
        await runWithSpawnInParallel(scripts.testStart(project, argv), project, argv);
      }
      await promisePool.promiseAll();
      // Check playwright installation because --ci includes --e2e implicitly
      if (argv.e2e !== 'none' && (await e2eTestsExistPromise)) {
        if (project.hasDockerfile) {
          await runWithSpawn(`${scripts.buildDocker(project, 'test')}`, project, argv);
        }
        const options = project.hasDockerfile
          ? {
              startCommand: dockerScripts.stopAndStart(project, true),
            }
          : {};
        process.exitCode = await runWithSpawn(scripts.testE2E(project, argv, options), project, argv, {
          exitIfFailed: false,
        });
        await runWithSpawn(dockerScripts.stop(project), project, argv);
      }
      continue;
    }

    if (argv.unit || (!argv.start && argv.e2e === undefined)) {
      promises.push(runWithSpawn(scripts.testUnit(project, argv), project, argv, { timeout: argv.unitTimeout }));
    }
    if (argv.start) {
      promises.push(runWithSpawn(scripts.testStart(project, argv), project, argv));
    }
    await Promise.all(promises);
    // Don't check playwright installation because --e2e is set explicitly
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
        await testOnDocker(project, argv, scripts, 'PWDEBUG=1 ');
        continue;
      }
    }
    if (deps['blitz'] || deps['next'] || devDeps['@remix-run/dev']) {
      switch (argv.e2e) {
        case 'headed': {
          await runWithSpawn(
            scripts.testE2E(project, argv, { playwrightArgs: 'test tests/e2e --headed' }),
            project,
            argv
          );
          continue;
        }
        case 'headed-dev': {
          await runWithSpawn(
            scripts.testE2EDev(project, argv, { playwrightArgs: 'test tests/e2e --headed' }),
            project,
            argv
          );
          continue;
        }
        case 'debug': {
          await runWithSpawn(`PWDEBUG=1 ${scripts.testE2E(project, argv, {})}`, project, argv);
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
          await runWithSpawn(`playwright show-trace`, project, argv);
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
  scripts: BaseExecutionScripts,
  prefix = ''
): Promise<void> {
  await runWithSpawn(`${scripts.buildDocker(project, 'test')}`, project, argv);
  process.exitCode = await runWithSpawn(
    `${prefix}${scripts.testE2E(project, argv, {
      startCommand: dockerScripts.stopAndStart(project, true),
    })}`,
    project,
    argv,
    { exitIfFailed: false }
  );
  await runWithSpawn(dockerScripts.stop(project), project, argv);
}
