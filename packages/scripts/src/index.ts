import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { buildIfNeeded } from './commands/buildIfNeeded.js';
import { generatePackageJsonForFunctions } from './commands/generatePackageJsonForFunctions.js';
import { optimizeForDockerBuild } from './commands/optimizeForDockerBuild.js';

await yargs(hideBin(process.argv))
  .command(buildIfNeeded)
  .command(generatePackageJsonForFunctions)
  .command(optimizeForDockerBuild)
  .demandCommand()
  .help().argv;
