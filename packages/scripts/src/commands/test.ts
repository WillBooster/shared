import type { CommandModule, InferredOptionTypes } from 'yargs';
import { ArgumentsCamelCase } from 'yargs';

import { project } from '../project.js';
import { promisePool } from '../promisePool.js';
import { blitzScripts, BlitzScriptsType } from '../scripts/blitzScripts.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import { expressScripts, ExpressScriptsType } from '../scripts/expressScripts.js';
import { runWithSpawn, runWithSpawnInParallel } from '../scripts/run.js';

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
    await test(argv);
  },
};

export async function test(argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder>>>): Promise<void> {
  const deps = project.packageJson.dependencies || {};
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
    if (argv.e2e !== false) {
      if (project.hasDockerfile) {
        await runWithSpawn(`${scripts.buildDocker('test')}`);
      }
      const options = project.hasDockerfile
        ? {
            startCommand: dockerScripts.stopAndStart(true),
          }
        : {};
      process.exitCode = await runWithSpawn(scripts.testE2E(options), { exitIfFailed: false });
      await runWithSpawn(dockerScripts.stop());
    }
    return;
  }

  if (argv.unit) {
    promises.push(runWithSpawn(scripts.testUnit(), { timeout: argv.unitTimeout }));
  }
  if (argv.start) {
    promises.push(runWithSpawn(scripts.testStart()));
  }
  await Promise.all(promises);
  if (argv.e2e) {
    switch (argv.e2eMode || 'headless') {
      case 'headless': {
        await runWithSpawn(scripts.testE2E({}));
        return;
      }
      case 'docker': {
        await runWithSpawn(`${scripts.buildDocker('test')}`);
        process.exitCode = await runWithSpawn(
          scripts.testE2E({
            startCommand: dockerScripts.stopAndStart(true),
          }),
          { exitIfFailed: false }
        );
        await runWithSpawn(dockerScripts.stop());
        return;
      }
    }
    if (deps['blitz']) {
      switch (argv.e2eMode || 'headless') {
        case 'headed': {
          await runWithSpawn(blitzScripts.testE2E({ playwrightArgs: 'test tests/e2e --headed' }));
          return;
        }
        case 'debug': {
          await runWithSpawn(`PWDEBUG=1 ${blitzScripts.testE2E({})}`);
          return;
        }
        case 'generate': {
          await runWithSpawn(blitzScripts.testE2E({ playwrightArgs: 'codegen http://localhost:8080' }));
          return;
        }
        case 'trace': {
          await runWithSpawn(`playwright show-trace`);
          return;
        }
      }
    }
    throw new Error(`Unknown e2e mode: ${argv.mode}`);
  }
}
