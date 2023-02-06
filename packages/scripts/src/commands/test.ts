import fs from 'node:fs/promises';

import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { blitzScripts } from '../scripts/blitzScripts.js';
import { runScript } from '../scripts/sharedScripts.js';

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
        const rmDockerPromise = runScript(blitzScripts.stopAllDocker());
        if (argv.unit !== false) {
          promises.push(runScript(`yarn vitest run tests/unit`));
        }
        if (argv.start !== false) {
          promises.push(runScript(`yarn concurrently --kill-others --raw "blitz dev" "${blitzScripts.waitApp()}"`));
        }
        promises.push(
          runScript(`yarn vitest run tests/unit`),
          runScript(`yarn concurrently --kill-others --raw "blitz dev" "${blitzScripts.waitApp()}"`)
        );
        await rmDockerPromise;
        promises.push(runScript(`${blitzScripts.buildDocker(name)}`));
        await Promise.all(promises);
        await runScript(blitzScripts.testE2E({ startCommand: `unbuffer ${blitzScripts.stopDocker(name)}` }));
      } else {
        if (argv.unit) {
          promises.push(runScript(`yarn vitest run tests/unit`));
        }
        if (argv.start) {
          promises.push(runScript(`yarn concurrently --kill-others --raw "blitz dev" "${blitzScripts.waitApp()}"`));
        }
        await Promise.all(promises);
        if (argv.e2e) {
          switch (argv.e2eMode) {
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

      //    "test": "yarn test:unit && yarn test:e2e && yarn test:start",
      //     "test/ci": "yarn stop-all-containers && yarn test:unit && yarn test:start && yarn run start-docker/build && START_CMD=\"unbuffer yarn run start-docker/run\" yarn test:e2e",
      //     "test/ci-setup": "yarn db:reset && playwright install",
      //     "test:e2e": "yarn run test:e2e/core",
      //     "test:e2e-debug": "PWDEBUG=1 yarn test:e2e",
      //     "test:e2e-gen": "PLAYWRIGHT_ARGS='codegen http://localhost:8080' yarn test:e2e",
      //     "test:e2e-headed": "PLAYWRIGHT_ARGS='test tests/e2e --headed' yarn test:e2e",
      //     "test:e2e/core": "APP_ENV=production dotenv -e .env.production -- concurrently --kill-others --raw --success first \"rm -Rf db/mount && ${START_CMD:-yarn start-prod}\" \"wait-on -t 300000 -i 2000 http://127.0.0.1:8080 && playwright ${PLAYWRIGHT_ARGS:-test tests/e2e}\"",
      //     "test:e2e:trace": "playwright show-trace",
      //     "test:start": "concurrently --kill-others --raw \"blitz dev -p 8080\" \"wait-on -t 60000 -i 2000 http://127.0.0.1:8080\"",
      //     "test:unit": "vitest run tests/unit",
    }
  },
};
