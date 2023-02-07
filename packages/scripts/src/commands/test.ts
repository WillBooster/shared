import fs from 'node:fs/promises';

import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { blitzScripts } from '../scripts/blitzScripts.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import { runScript } from '../scripts/sharedScripts.js';

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
        const rmDockerPromise = runScript(dockerScripts.stopAll());
        if (argv.unit !== false) {
          promises.push(runScript(blitzScripts.testUnit()));
        }
        if (argv.start !== false) {
          promises.push(runScript(blitzScripts.testStart()));
        }
        await rmDockerPromise;
        promises.push(runScript(`${blitzScripts.buildDocker(name)}`));
        await Promise.all(promises);
        if (argv.e2e !== false) {
          process.exitCode = await runScript(
            blitzScripts.testE2E({
              startCommand: `unbuffer ${dockerScripts.start(name, blitzScripts.dockerRunAdditionalArgs)}`,
            }),
            false
          );
          await runScript(dockerScripts.stop(name));
        }
      } else {
        if (argv.unit) {
          promises.push(runScript(blitzScripts.testUnit()));
        }
        if (argv.start) {
          promises.push(runScript(blitzScripts.testStart()));
        }
        await Promise.all(promises);
        if (argv.e2e) {
          switch (argv.e2eMode || 'headless') {
            case 'headless': {
              await runScript(blitzScripts.testE2E({}));
              break;
            }
            case 'headed': {
              await runScript(blitzScripts.testE2E({ playwrightArgs: 'test tests/e2e --headed' }));
              break;
            }
            case 'debug': {
              await runScript(`PWDEBUG=1 ${blitzScripts.testE2E({})}`);
              break;
            }
            case 'generate': {
              await runScript(blitzScripts.testE2E({ playwrightArgs: 'codegen http://localhost:8080' }));
              break;
            }
            case 'trace': {
              await runScript(`yarn playwright show-trace`);
              break;
            }
          }
        }
      }
    }
  },
};
