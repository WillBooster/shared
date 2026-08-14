import chalk from 'chalk';
import killPortProcess from 'kill-port';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { isCI } from '../utils/ci.js';
import { computePreferredPort } from '../utils/port.js';

const killPortIfNonCiBuilder = {} as const;

export const killPortIfNonCiCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof killPortIfNonCiBuilder & typeof sharedOptionsBuilder>
> = {
  command: 'kill-port-if-non-ci',
  describe: 'Kill the process on the PORT environment variable (or the auto-selection preferred port) if non-CI.',
  builder: killPortIfNonCiBuilder,
  async handler(argv) {
    await killPortIfNonCi(argv);
  },
};

export async function killPortIfNonCi(
  argv: ArgumentsCamelCase<InferredOptionTypes<typeof killPortIfNonCiBuilder & typeof sharedOptionsBuilder>>
): Promise<void> {
  const project = findSelfProject(argv);
  if (!project) {
    console.error(chalk.red('No project found.'));
    process.exit(1);
  }

  if (isCI(project.env.CI)) {
    console.info(`Skip killing port due to CI: ${project.env.CI}`);
    return;
  }

  const portEnv = project.env.PORT;
  // Without a configured PORT (matching ensurePort's falsy check, so an empty value counts too),
  // reclaim the deterministic preferred port ensurePort starts its search from, so a leftover
  // server (e.g. after SIGKILL) cannot shift the auto-selected URL.
  const port = portEnv ? Number(portEnv) : computePreferredPort(project);
  if (!Number.isInteger(port) || port <= 0) {
    console.error(chalk.red(`PORT environment variable is invalid: ${portEnv}`));
    process.exit(1);
  }

  console.info(`Killing the port: ${port}`);
  try {
    await killPortProcess(port);
  } catch {
    // do nothing
  }
}
