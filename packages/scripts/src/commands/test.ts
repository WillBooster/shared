import fs from 'node:fs/promises';

import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { blitzScripts } from '../scripts/blitzScripts.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import { runScript } from '../scripts/sharedScripts.js';
import { sharedOptions } from '../sharedOptions.js';

const builder = {
  ci: {
    description: 'Whether to run tests on CI',
    type: 'boolean',
    alias: 'c',
  },
  e2e: {
    description: 'Whether to run e2e tests',
    type: 'boolean',
    alias: 'e',
  },
  e2eMode: {
    description: 'e2e mode: headless (default) | headed | debug | generate | trace',
    type: 'string',
    alias: 'em',
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
  ...sharedOptions,
} as const;

export const test: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'test',
  describe: 'Test project',
  builder,
  async handler(argv) {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
    const name = packageJson.name || 'unknown';
    if (packageJson.dependencies?.['blitz']) {
      const promises: Promise<number>[] = [];
      if (argv.ci) {
        const rmDockerPromise = runScript(dockerScripts.stopAll(), argv.verbose);
        if (argv.unit !== false) {
          promises.push(runScript(blitzScripts.testUnit(), argv.verbose));
        }
        if (argv.start !== false) {
          promises.push(runScript(blitzScripts.testStart(), argv.verbose));
        }
        await rmDockerPromise;
        promises.push(runScript(`${blitzScripts.buildDocker(name)}`, argv.verbose));
        await Promise.all(promises);
        await runScript(
          blitzScripts.testE2E({
            startCommand: `unbuffer ${dockerScripts.start(name, blitzScripts.dockerRunAdditionalArgs)}`,
          }),
          argv.verbose
        );
      } else {
        if (argv.unit) {
          promises.push(runScript(blitzScripts.testUnit(), argv.verbose));
        }
        if (argv.start) {
          promises.push(runScript(blitzScripts.testStart(), argv.verbose));
        }
        await Promise.all(promises);
        if (argv.e2e) {
          switch (argv.e2eMode) {
            case 'headless': {
              await runScript(blitzScripts.testE2E({}), argv.verbose);
              break;
            }
            case 'headed': {
              await runScript(blitzScripts.testE2E({ playwrightArgs: 'test tests/e2e --headed' }), argv.verbose);
              break;
            }
            case 'debug': {
              await runScript(`PWDEBUG=1 ${blitzScripts.testE2E({})}`, argv.verbose);
              break;
            }
            case 'generate': {
              await runScript(blitzScripts.testE2E({ playwrightArgs: 'codegen http://localhost:8080' }), argv.verbose);
              break;
            }
            case 'trace': {
              await runScript(`yarn playwright show-trace`, argv.verbose);
              break;
            }
          }
        }
      }
    }
  },
};
