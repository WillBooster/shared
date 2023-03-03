import path from 'node:path';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { buildIfNeededCommand } from './commands/buildIfNeeded.js';
import { dbCommand } from './commands/db.js';
import { optimizeForDockerBuildCommand } from './commands/optimizeForDockerBuild.js';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { testCommand } from './commands/test.js';
import { typeCheckCommand } from './commands/typecheck.js';
import { project } from './project.js';
import { preprocessedOptions } from './sharedOptions.js';

await yargs(hideBin(process.argv))
  .scriptName('wb')
  .options(preprocessedOptions)
  .middleware((argv) => {
    const workingDir = argv['working-dir'];
    if (workingDir) {
      const dirPath = path.resolve(workingDir);
      process.chdir(dirPath);
      project.dirPath = dirPath;
    }
  })
  .command(setupCommand)
  .command(buildIfNeededCommand)
  .command(optimizeForDockerBuildCommand)
  .command(dbCommand)
  .command(startCommand)
  .command(testCommand)
  .command(typeCheckCommand)
  .demandCommand()
  .strict()
  .help().argv;

for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
  process.on(signal, () => process.exit());
}
