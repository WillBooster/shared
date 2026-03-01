import fs from 'node:fs';
import path from 'node:path';

import { removeNpmAndYarnEnvironmentVariables, treeKill } from '@willbooster/shared-lib-node/src';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { buildIfNeededCommand } from './commands/buildIfNeeded.js';
import { killPortIfNonCiCommand } from './commands/killPortIfNonCi.js';
import { lintCommand } from './commands/lint.js';
import { optimizeForDockerBuildCommand } from './commands/optimizeForDockerBuild.js';
import { prismaCommand } from './commands/prisma.js';
import { retryCommand } from './commands/retry.js';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { testCommand } from './commands/test.js';
import { testOnCiCommand } from './commands/testOnCi.js';
import { treeKillCommand } from './commands/treeKill.js';
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
  })
  .command(buildIfNeededCommand)
  .command(killPortIfNonCiCommand)
  .command(lintCommand)
  .command(optimizeForDockerBuildCommand)
  .command(prismaCommand)
  .command(retryCommand)
  .command(setupCommand)
  .command(startCommand)
  .command(testCommand)
  .command(testOnCiCommand)
  .command(treeKillCommand)
  .command(typeCheckCommand)
  .command(tcCommand)
  .demandCommand()
  .strict()
  .version(getVersion())
  .help().argv;

function getVersion(): string {
  let packageJsonDir = path.dirname(new URL(import.meta.url).pathname);
  while (!fs.existsSync(path.join(packageJsonDir, 'package.json'))) {
    packageJsonDir = path.dirname(packageJsonDir);
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageJsonDir, 'package.json'), 'utf8')) as {
    version: string;
  };
  return packageJson.version;
}

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
  process.on(signal, () => {
    if (shuttingDown) return;

    shuttingDown = true;
    try {
      treeKill(process.pid);
    } catch (error) {
      console.warn(`Failed to treeKill(${process.pid}) during shutdown:`, error);
    }
    process.exit();
  });
}
