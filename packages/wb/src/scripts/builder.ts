import type { ArgumentsCamelCase, InferredOptionTypes } from 'yargs';

import { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

export const scriptOptionsBuilder = {
  ...sharedOptionsBuilder,
  watch: {
    description: 'Whether to watch files',
    type: 'boolean',
  },
  args: {
    description: 'Arguments text for start command',
    type: 'array',
    alias: 'a',
    default: [],
  },
} as const;

export type ScriptArgv = Partial<ArgumentsCamelCase<InferredOptionTypes<typeof scriptOptionsBuilder>>> & {
  normalizedArgsText?: string;
};

export function normalizeArgs(
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof scriptOptionsBuilder>>>
): void {
  (argv as ScriptArgv).normalizedArgsText = [...(argv.args ?? []), ...(argv._?.slice(1) ?? [])]
    .map((arg) => `'${arg}'`)
    .join(' ');
}
