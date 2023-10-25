import path from 'node:path';

import {
  loadEnvironmentVariables,
  removeNpmAndYarnEnvironmentVariables,
  saveEnvironmentVariables,
} from '@willbooster/shared-lib-node/src';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { buildIfNeededCommand } from './commands/buildIfNeeded.js';
import { optimizeForDockerBuildCommand } from './commands/optimizeForDockerBuild.js';
import { prismaCommand } from './commands/prisma.js';
import { retryCommand } from './commands/retry.js';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { testCommand } from './commands/test.js';
import { tcCommand, typeCheckCommand } from './commands/typecheck.js';
import { sharedOptionsBuilder } from './sharedOptionsBuilder.js';

await yargs(hideBin(process.argv))
  .scriptName('wb')
  .options(sharedOptionsBuilder)
  .middleware((argv) => {
    const workingDir = argv['working-dir'];
    if (workingDir) {
      const dirPath = path.resolve(workingDir);
      process.chdir(dirPath);
    }

    removeNpmAndYarnEnvironmentVariables(process.env);
    saveEnvironmentVariables();

    // const command = argv._[0].toString();
    // if (['start', 'tc', 'typecheck'].includes(command)) return;
    // if (command === 'test') {
    //   process.env.WB_ENV ||= 'test';
    // }
    // loadEnvironmentVariables(argv, project.dirPath);
  })
  .command(buildIfNeededCommand)
  .command(optimizeForDockerBuildCommand)
  .command(prismaCommand)
  .command(retryCommand)
  .command(setupCommand)
  .command(startCommand)
  .command(testCommand)
  .command(typeCheckCommand)
  .command(tcCommand)
  .demandCommand()
  .strict()
  .help().argv;

for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
  process.on(signal, () => process.exit());
}
