import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { buildIfNeeded } from './commands/buildIfNeeded.js';
import { generatePackageJsonForFunctions } from './commands/generatePackageJsonForFunctions.js';
import { optimizeForDockerBuild } from './commands/optimizeForDockerBuild.js';
import { setup } from './commands/setup.js';
import { start } from './commands/start.js';
import { test } from './commands/test.js';
import { sharedOptions } from './sharedOptions.js';

await yargs(hideBin(process.argv))
  .scriptName('wb')
  .options(sharedOptions)
  .middleware((argv) => {
    const workingDir = argv['working-dir'];
    if (workingDir) {
      process.chdir(workingDir);
    }
  })
  .command(setup)
  .command(buildIfNeeded)
  .command(generatePackageJsonForFunctions)
  .command(optimizeForDockerBuild)
  .command(start)
  .command(test)
  .demandCommand()
  .strict()
  .help().argv;
