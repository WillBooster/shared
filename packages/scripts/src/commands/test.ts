import fs from 'node:fs/promises';

import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { blitzScripts } from '../scripts/blitzScripts.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import { runWithSpawn, runWithYarn } from '../scripts/run.js';

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
    description: 'e2e mode: headless (default) | headed | debug | generate | trace',
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
    if (packageJson.dependencies?.['blitz']) {
      const promises: Promise<unknown>[] = [];
      if (argv.ci) {
        promises.push(runWithYarn(dockerScripts.stopAll()));
        if (argv.unit !== false) {
          promises.push(runWithSpawn(blitzScripts.testUnit(), { timeout: argv.unitTimeout }));
        }
        if (argv.start !== false) {
          promises.push(runWithYarn(blitzScripts.testStart()));
        }
        await Promise.all(promises);
        await runWithSpawn(`${blitzScripts.buildDocker(name, 'test')}`);
        if (argv.e2e !== false) {
          process.exitCode = await runWithYarn(
            blitzScripts.testE2E({
              startCommand: dockerScripts.stopAndStart(name, true),
            }),
            { exitIfFailed: false }
          );
          await runWithYarn(dockerScripts.stop(name));
        }
      } else {
        if (argv.unit) {
          promises.push(runWithSpawn(blitzScripts.testUnit(), { timeout: argv.unitTimeout }));
        }
        if (argv.start) {
          promises.push(runWithYarn(blitzScripts.testStart()));
        }
        await Promise.all(promises);
        if (argv.e2e) {
          switch (argv.e2eMode || 'headless') {
            case 'headless': {
              await runWithYarn(blitzScripts.testE2E({}));
              break;
            }
            case 'headed': {
              await runWithYarn(blitzScripts.testE2E({ playwrightArgs: 'test tests/e2e --headed' }));
              break;
            }
            case 'debug': {
              await runWithYarn(`PWDEBUG=1 ${blitzScripts.testE2E({})}`);
              break;
            }
            case 'generate': {
              await runWithYarn(blitzScripts.testE2E({ playwrightArgs: 'codegen http://localhost:8080' }));
              break;
            }
            case 'trace': {
              await runWithYarn(`yarn playwright show-trace`);
              break;
            }
          }
        }
      }
    }
  },
};
