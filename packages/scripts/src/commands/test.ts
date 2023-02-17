import fs from 'node:fs/promises';

import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { promisePool } from '../promisePool.js';
import { blitzScripts, BlitzScriptsType } from '../scripts/blitzScripts.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import { expressScripts, ExpressScriptsType } from '../scripts/expressScripts.js';
import { runWithSpawn, runWithSpawnInParallel, runWithYarn } from '../scripts/run.js';

const builder = {
  ci: {
    description: 'Whether to run tests on CI',
    type: 'boolean',
  },
  e2e: {
    description: 'Whether to run e2e tests',
    type: 'boolean',
    alias: 'e',
  },
  'e2e-mode': {
    description: 'e2e mode: headless (default) | docker | headed | debug | generate | trace',
    type: 'string',
    alias: 'm',
  },
  start: {
    description: 'Whether to run start tests',
    type: 'boolean',
    alias: 's',
  },
  unit: {
    description: 'Whether to run unit tests',
    type: 'boolean',
    alias: 'u',
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
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
    const name = packageJson.name || 'unknown';
    const deps = packageJson.dependencies || {};
    let scripts: BlitzScriptsType | ExpressScriptsType | undefined;
    if (deps['blitz']) {
      scripts = blitzScripts;
    } else if (deps['express'] && !deps['firebase-functions']) {
      scripts = expressScripts;
    }
    if (!scripts) return;

    const promises: Promise<unknown>[] = [];
    if (argv.ci) {
      await runWithSpawnInParallel(dockerScripts.stopAll());
      if (argv.unit !== false) {
        await runWithSpawnInParallel(scripts.testUnit(), { timeout: argv.unitTimeout });
      }
      if (argv.start !== false) {
        await runWithSpawnInParallel(scripts.testStart());
      }
      await promisePool.promiseAll();
      await runWithSpawn(`${scripts.buildDocker(name, packageJson, 'test')}`);
      if (argv.e2e !== false) {
        process.exitCode = await runWithYarn(
          scripts.testE2E({
            startCommand: dockerScripts.stopAndStart(name, true),
          }),
          { exitIfFailed: false }
        );
        await runWithYarn(dockerScripts.stop(name));
      }
      return;
    }

    if (argv.unit) {
      promises.push(runWithSpawn(scripts.testUnit(), { timeout: argv.unitTimeout }));
    }
    if (argv.start) {
      promises.push(runWithYarn(scripts.testStart()));
    }
    await Promise.all(promises);
    if (argv.e2e) {
      switch (argv.e2eMode || 'headless') {
        case 'headless': {
          await runWithYarn(scripts.testE2E({}));
          return;
        }
        case 'docker': {
          await runWithSpawn(`${scripts.buildDocker(name, packageJson, 'test')}`);
          process.exitCode = await runWithYarn(
            scripts.testE2E({
              startCommand: dockerScripts.stopAndStart(name, true),
            }),
            { exitIfFailed: false }
          );
          await runWithYarn(dockerScripts.stop(name));
          return;
        }
      }
      if (deps['blitz']) {
        switch (argv.e2eMode || 'headless') {
          case 'headed': {
            await runWithYarn(blitzScripts.testE2E({ playwrightArgs: 'test tests/e2e --headed' }));
            return;
          }
          case 'debug': {
            await runWithYarn(`PWDEBUG=1 ${blitzScripts.testE2E({})}`);
            return;
          }
          case 'generate': {
            await runWithYarn(blitzScripts.testE2E({ playwrightArgs: 'codegen http://localhost:8080' }));
            return;
          }
          case 'trace': {
            await runWithYarn(`yarn playwright show-trace`);
            return;
          }
        }
      }
      throw new Error(`Unknown e2e mode: ${argv.mode}`);
    }
  },
};
