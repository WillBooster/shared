import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject } from '../project.js';
import { runWithSpawn } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const checkEnvBuilder = {} as const;

export const checkEnvCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof checkEnvBuilder & typeof sharedOptionsBuilder>
> = {
  command: 'check-env',
  describe:
    'Verify that every fnox-declared environment variable and secret resolves for the current WB_ENV. Prefix scripts that write to remote environments with this command to fail fast on missing secrets.',
  builder: checkEnvBuilder,
  async handler(argv) {
    await checkEnv(argv);
  },
};

export async function checkEnv(
  argv: ArgumentsCamelCase<InferredOptionTypes<typeof checkEnvBuilder & typeof sharedOptionsBuilder>>
): Promise<void> {
  const project = findSelfProject(argv);
  if (!project) {
    console.error(chalk.red('No project found.'));
    process.exit(1);
  }

  if (!fs.existsSync(path.join(project.dirPath, 'fnox.toml'))) {
    console.info('No fnox.toml found; nothing to check.');
    return;
  }

  // Reading project.env resolves and validates WB_ENV (completeAndValidateWbEnv), so the profile
  // below is the same one every other wb command would load.
  const profile = project.env.WB_ENV || 'development';
  // `--if-missing error` makes unresolvable secrets (e.g. a missing age identity) a hard failure,
  // unlike the tolerant default used for ordinary env loading.
  const exitCode = await runWithSpawn(
    `fnox export --all --format json --no-daemon --if-missing error --profile ${profile} > /dev/null`,
    project,
    argv,
    { exitIfFailed: false }
  );
  if (exitCode !== 0) {
    console.error(chalk.red(`Failed to resolve fnox-declared environment variables for profile "${profile}".`));
    process.exit(exitCode);
  }
  console.info(`All fnox-declared environment variables resolve for profile "${profile}".`);
}
