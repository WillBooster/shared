import path from 'node:path';

import { config } from 'dotenv';
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

    // Remove npm & yarn environment variables from process.env
    for (const key of Object.keys(process.env)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.startsWith('npm_') || lowerKey.startsWith('yarn_') || lowerKey.startsWith('berry_')) {
        delete process.env[key];
      }
    }

    let envPaths = (argv.env ?? []).map((envPath) => envPath.toString());
    const cascade = argv.nodeEnv ? process.env.NODE_ENV : argv.cascade;
    if (typeof cascade === 'string') {
      if (envPaths.length === 0) envPaths.push('.env');
      envPaths = envPaths.flatMap((envPath) =>
        cascade
          ? [`${envPath}.${cascade}.local`, `${envPath}.local`, `${envPath}.${cascade}`, envPath]
          : [`${envPath}.local`, envPath]
      );
    }
    if (argv.verbose) {
      console.info('Loading env files:', envPaths);
    }
    for (const envPath of envPaths) {
      config({ path: path.join(project.dirPath, envPath) });
    }
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
