import chalk from 'chalk';
import type { Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject } from '../project.js';
import { runWithSpawn } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { buildVinextCommand } from '../utils/wrangler.js';

const builder = {} as const;

const _argumentsBuilder = {
  args: {
    description: 'Arguments for the vinext CLI',
    type: 'array',
  },
} as const;

/**
 * Run the vinext CLI with the real Node.js runtime. Package scripts (build/dev/start) should use
 * this instead of invoking `vinext` directly: vite 8 requires `module.registerHooks`, which Bun
 * lacks, and `bun --bun` (or bunfig's `run.bun`) shims `node` in PATH to Bun, so a bare `vinext`
 * invocation breaks whenever the script runs inside a Bun-shimmed chain (e.g. via wb).
 */
export const vinextCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder & typeof _argumentsBuilder>
> = {
  command: 'vinext [args...]',
  describe: 'Run the vinext CLI with the real Node.js runtime',
  builder: (yargs) =>
    yargs.parserConfiguration({ 'populate--': true, 'unknown-options-as-args': true }) as unknown as Argv<
      InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder & typeof _argumentsBuilder>
    >,
  async handler(argv) {
    const project = findSelfProject(argv);
    if (!project) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const args = [...(argv.args ?? []), ...argv._.slice(1), ...((argv['--'] as unknown[] | undefined) ?? [])]
      .map(String)
      .filter(Boolean);
    const exitCode = await runWithSpawn(buildVinextCommand(project, args.join(' ')), project, argv);
    process.exit(exitCode);
  },
};
