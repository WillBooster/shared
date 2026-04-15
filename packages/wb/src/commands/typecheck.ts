import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

import { lint, type LintCommandArgv } from './lint.js';

const builder = {} as const;

type TypeCheckCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
export type TypeCheckCommandArgv = ArgumentsCamelCase<TypeCheckCommandOptions>;

export const typeCheckCommand: CommandModule<unknown, TypeCheckCommandOptions> = {
  command: 'typecheck',
  describe: 'Run Oxlint type-aware type checking. .env files are ignored.',
  builder,
  async handler(argv) {
    process.exit(await typeCheck(argv));
  },
};

export async function typeCheck(argv: TypeCheckCommandArgv): Promise<number> {
  return lint({ ...argv, _: ['lint'], quiet: true } as LintCommandArgv);
}

export const tcCommand: CommandModule<unknown, TypeCheckCommandOptions> = {
  ...typeCheckCommand,
  command: 'tc',
};
