import fs from 'node:fs';
import path from 'node:path';

import { removeNpmAndYarnEnvironmentVariables, treeKill } from '@willbooster/shared-lib-node/src';
import { protectRunScriptArgs } from '../bin/runArgs.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { buildIfNeededCommand } from './commands/buildIfNeeded.js';
import { checkEnvCommand } from './commands/checkEnv.js';
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

    // Warn only when a shim actually wins `node` resolution: oven/bun images append a harmless
    // /usr/local/bun-node-fallback-bin (node -> bun) at the END of PATH, so a PATH substring
    // check false-positives whenever a real node precedes it.
    const nodeOnPath = findFirstNodeOnPath();
    if (nodeOnPath && isBunNodeShim(nodeOnPath)) {
      // Not fixed up here: tools requiring real Node.js (Playwright, wrangler, vinext) may hang or
      // crash under the shim, and some (wrangler dev) fail silently, so surface the cause upfront.
      console.warn(
        `Warning: \`node\` on PATH is a Bun shim (${nodeOnPath}); ` +
          'run wb without `--bun` and remove `[run] bun` from bunfig.toml.'
      );
    }

    if (argv._[0] !== 'run') removeNpmAndYarnEnvironmentVariables(process.env);
  })
  .command(verifyCodeCommand)
  .command(buildIfNeededCommand)
  .command(checkEnvCommand)
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

/** The first executable `node` on PATH, i.e. the one child processes will run. */
function findFirstNodeOnPath(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;

    const nodePath = path.join(dir, 'node');
    try {
      fs.accessSync(nodePath, fs.constants.X_OK);
      return nodePath;
    } catch {
      // Not present or not executable in this directory; keep searching.
    }
  }
  return undefined;
}

function isBunNodeShim(nodePath: string): boolean {
  // `bun --bun` and bunfig's `run.bun` prepend a bun-node-<version> directory whose `node` links
  // to bun, and oven/bun images symlink node -> bun in bun-node-fallback-bin, so the giveaway is
  // either a bun-node- path segment or a resolution to the bun binary itself.
  if (nodePath.includes('/bun-node-')) return true;
  try {
    return path.basename(fs.realpathSync(nodePath)) === 'bun';
  } catch {
    return false;
  }
}

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
