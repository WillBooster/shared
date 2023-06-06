import path from 'node:path';

import { existsAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes , ArgumentsCamelCase } from 'yargs';

import { project } from '../project.js';
import { promisePool } from '../promisePool.js';
import type { BlitzScriptsType } from '../scripts/blitzScripts.js';
import { blitzScripts } from '../scripts/blitzScripts.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import type { HttpServerScriptsType } from '../scripts/httpServerScripts.js';
import { httpServerScripts } from '../scripts/httpServerScripts.js';
import { runWithSpawn, runWithSpawnInParallel } from '../scripts/run.js';
import { sharedOptions } from '../sharedOptions.js';

const builder = {
  ...sharedOptions,
  ci: {
    description: 'Whether to run tests on CI',
    type: 'boolean',
  },
  e2e: {
    description: 'e2e mode: none (default) | headless | docker | headed | debug | generate | trace',
    default: '',
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

export const testCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'test',
  describe: 'Test project',
  builder,
  async handler(argv) {
    await test(argv);
  },
};

export async function test(argv: ArgumentsCamelCase<InferredOptionTypes<typeof builder>>): Promise<void> {
  if (project.packageJson.workspaces) {
    process.env['CI'] = '1';
    process.env['FORCE_COLOR'] = '3';
    await runWithSpawn(
      ['yarn', 'workspaces', 'foreach', '--verbose', 'run', 'wb', ...process.argv.slice(2)].join(' '),
      argv
    );
    return;
  }

  const deps = project.packageJson.dependencies || {};
  const devDeps = project.packageJson.devDependencies || {};
  let scripts: BlitzScriptsType | HttpServerScriptsType | undefined;
  if (deps['blitz']) {
    scripts = blitzScripts;
  } else if (deps['express'] && !deps['firebase-functions']) {
    scripts = httpServerScripts;
  }
  if (!scripts) {
    console.error(chalk.red('Unable to determine the method for testing the app.'));
    return;
  }

  const promises: Promise<unknown>[] = [];
  if (argv.ci) {
    const unitTestsExistPromise = existsAsync(path.join(project.dirPath, 'tests', 'unit'));
    const e2eTestsExistPromise = existsAsync(path.join(project.dirPath, 'tests', 'e2e'));

    await runWithSpawnInParallel(dockerScripts.stopAll(), argv);
    if (argv.unit !== false && (await unitTestsExistPromise)) {
      await runWithSpawnInParallel(scripts.testUnit(), argv, { timeout: argv.unitTimeout });
    }
    if (argv.start !== false) {
      await runWithSpawnInParallel(scripts.testStart(), argv);
    }
    await promisePool.promiseAll();
    // Check playwright installation because --ci includes --e2e implicitly
    if (argv.e2e !== 'none' && (await e2eTestsExistPromise)) {
      if (project.hasDockerfile) {
        await runWithSpawn(`${scripts.buildDocker('test')}`, argv);
      }
      const options = project.hasDockerfile
        ? {
            startCommand: dockerScripts.stopAndStart(true),
          }
        : {};
      process.exitCode = await runWithSpawn(scripts.testE2E(options), argv, { exitIfFailed: false });
      await runWithSpawn(dockerScripts.stop(), argv);
    }
    return;
  }

  if (argv.unit || (!argv.start && !argv.e2e)) {
    promises.push(runWithSpawn(scripts.testUnit(), argv, { timeout: argv.unitTimeout }));
  }
  if (argv.start) {
    promises.push(runWithSpawn(scripts.testStart(), argv));
  }
  await Promise.all(promises);
  // Don't check playwright installation because --e2e is set explicitly
  switch (argv.e2e) {
    case '':
    case 'none': {
      return;
    }
    case 'headless': {
      await runWithSpawn(scripts.testE2E({}), argv);
      return;
    }
    case 'docker': {
      await runWithSpawn(`${scripts.buildDocker('test')}`, argv);
      process.exitCode = await runWithSpawn(
        scripts.testE2E({
          startCommand: dockerScripts.stopAndStart(true),
        }),
        argv,
        { exitIfFailed: false }
      );
      await runWithSpawn(dockerScripts.stop(), argv);
      return;
    }
  }
  if (deps['blitz']) {
    switch (argv.e2e) {
      case 'headed': {
        await runWithSpawn(blitzScripts.testE2E({ playwrightArgs: 'test tests/e2e --headed' }), argv);
        return;
      }
      case 'debug': {
        await runWithSpawn(`PWDEBUG=1 ${blitzScripts.testE2E({})}`, argv);
        return;
      }
      case 'generate': {
        await runWithSpawn(blitzScripts.testE2E({ playwrightArgs: 'codegen http://localhost:8080' }), argv);
        return;
      }
      case 'trace': {
        await runWithSpawn(`playwright show-trace`, argv);
        return;
      }
    }
  } else if (devDeps['@remix-run/dev']) {
    // TODO: implement commands for remix
  }
  throw new Error(`Unknown e2e mode: ${argv.mode}`);
}
