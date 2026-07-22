import fs from 'node:fs';
import path from 'node:path';

import { removeNpmAndYarnEnvironmentVariables, treeKill } from '@willbooster/shared-lib-node/src';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { buildIfNeededCommand } from './commands/buildIfNeeded.js';
import { concurrentlyCommand } from './commands/concurrently.js';
import { deployCommand } from './commands/deploy.js';
import { dotenvCommand } from './commands/dotenv.js';
import { genCodeCommand } from './commands/genCode.js';
import { genDevVarsCommand } from './commands/genDevVars.js';
import { killPortIfNonCiCommand } from './commands/killPortIfNonCi.js';
import { lintCommand } from './commands/lint.js';
import { maintenanceCommand } from './commands/maintenance.js';
import { optimizeForDockerBuildCommand } from './commands/optimizeForDockerBuild.js';
import { prismaCommand } from './commands/prisma.js';
import { railwayEnvCommand } from './commands/railwayEnv.js';
import { releaseCommand } from './commands/release.js';
import { retryCommand } from './commands/retry.js';
import { runCommand } from './commands/run.js';
import { setupCommand } from './commands/setup.js';
import { setupPrivatePackagesCommand } from './commands/setupPrivatePackages.js';
import { startCommand } from './commands/start.js';
import { testCommand } from './commands/test.js';
import { testOnCiCommand } from './commands/testOnCi.js';
import { treeKillCommand } from './commands/treeKill.js';
import { tcCommand, typeCheckCommand } from './commands/typecheck.js';
import { verifyCodeCommand } from './commands/verifyCode.js';
import { sharedOptionsBuilder } from './sharedOptionsBuilder.js';
import { protectRunScriptArgs } from './utils/runArgs.js';

protectRunScriptArgs(process.argv);

await yargs(hideBin(process.argv))
  .scriptName('wb')
  .options(sharedOptionsBuilder)
  .middleware((argv) => {
    const workingDir = argv['working-dir'];
    if (workingDir) {
      const dirPath = path.resolve(workingDir);
      process.chdir(dirPath);
    }

    if (process.env.PATH?.includes('/bun-node-')) {
      // Not fixed up here: tools requiring real Node.js (Playwright, wrangler, vinext) may hang or
      // crash under the shim, and some (wrangler dev) fail silently, so surface the cause upfront.
      console.warn(
        "Warning: PATH contains a bun-node shim (from `bun --bun` or bunfig's `run.bun`); " +
          'run wb without `--bun` and remove `[run] bun` from bunfig.toml.'
      );
    }

    if (argv._[0] !== 'run') removeNpmAndYarnEnvironmentVariables(process.env);
  })
  .command(verifyCodeCommand)
  .command(buildIfNeededCommand)
  .command(concurrentlyCommand)
  .command(deployCommand)
  .command(dotenvCommand)
  .command(genCodeCommand)
  .command(genDevVarsCommand)
  .command(killPortIfNonCiCommand)
  .command(lintCommand)
  .command(maintenanceCommand)
  .command(optimizeForDockerBuildCommand)
  .command(prismaCommand)
  .command(railwayEnvCommand)
  .command(releaseCommand)
  .command(retryCommand)
  .command(runCommand)
  .command(setupCommand)
  .command(setupPrivatePackagesCommand)
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
