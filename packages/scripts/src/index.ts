import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { buildIfNeeded } from './commands/buildIfNeeded.js';
import { generatePackageJsonForFunctions } from './commands/generatePackageJsonForFunctions.js';
import { optimizeForDockerBuild } from './commands/optimizeForDockerBuild.js';
import { setup } from './commands/setup.js';
import { sharedOptions } from './sharedOptions.js';

await yargs(hideBin(process.argv))
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
  .demandCommand()
  .help().argv;
