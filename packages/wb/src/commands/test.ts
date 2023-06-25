import path from 'node:path';

import { existsAsync } from '@willbooster/shared-lib-node/src';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import { project } from '../project.js';
import { promisePool } from '../promisePool.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import { blitzScripts } from '../scripts/execution/blitzScripts.js';
import type { ExecutionScripts } from '../scripts/execution/executionScripts.js';
import { httpServerScripts } from '../scripts/execution/httpServerScripts.js';
import { plainAppScripts } from '../scripts/execution/plainAppScripts.js';
import { remixScripts } from '../scripts/execution/remixScripts.js';
import { runOnEachWorkspaceIfNeeded, runWithSpawn, runWithSpawnInParallel } from '../scripts/run.js';
import { sharedOptions } from '../sharedOptions.js';

const builder = {
  ...sharedOptions,
  ci: {
    description: 'Whether to run tests on CI',
    type: 'boolean',
  },
  e2e: {
    description:
      'Whether to run e2e tests. You may pass mode as argument: none | headless (default) | docker | headed | debug | generate | trace',
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
  await runOnEachWorkspaceIfNeeded(argv);

  const deps = project.packageJson.dependencies || {};
  const devDeps = project.packageJson.devDependencies || {};
  let scripts: ExecutionScripts;
  if (deps['blitz']) {
    scripts = blitzScripts;
  } else if (devDeps['@remix-run/dev']) {
    scripts = remixScripts;
  } else if ((deps['express'] || deps['fastify']) && !deps['firebase-functions']) {
    scripts = httpServerScripts;
  } else {
    scripts = plainAppScripts;
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

  if (argv.unit || (!argv.start && argv.e2e === undefined)) {
    promises.push(runWithSpawn(scripts.testUnit(), argv, { timeout: argv.unitTimeout }));
  }
  if (argv.start) {
    promises.push(runWithSpawn(scripts.testStart(), argv));
  }
  await Promise.all(promises);
  // Don't check playwright installation because --e2e is set explicitly
  switch (argv.e2e) {
    case undefined:
    case 'none': {
      return;
    }
    case '':
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
  if (deps['blitz'] || devDeps['@remix-run/dev']) {
    switch (argv.e2e) {
      case 'headed': {
        await runWithSpawn(scripts.testE2E({ playwrightArgs: 'test tests/e2e --headed' }), argv);
        return;
      }
      case 'debug': {
        await runWithSpawn(`PWDEBUG=1 ${scripts.testE2E({})}`, argv);
        return;
      }
      case 'generate': {
        await runWithSpawn(scripts.testE2E({ playwrightArgs: 'codegen http://localhost:8080' }), argv);
        return;
      }
      case 'trace': {
        await runWithSpawn(`playwright show-trace`, argv);
        return;
      }
    }
  }
  throw new Error(`Unknown e2e mode: ${argv.e2e}`);
}
