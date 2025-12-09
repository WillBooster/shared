import type { ArgumentsCamelCase, InferredOptionTypes } from 'yargs';

export const scriptOptionsBuilder = {
  watch: {
    description: 'Whether to watch files',
    type: 'boolean',
  },
  args: {
    description: 'Arguments for core command',
    type: 'array',
    alias: 'a',
    default: [],
  },
  'docker-options': {
    description: 'Arguments for "docker run"',
    type: 'array',
    default: [],
  },
} as const;

export type ScriptArgv = Partial<ArgumentsCamelCase<InferredOptionTypes<typeof scriptOptionsBuilder>>> & {
  normalizedArgsText?: string;
  normalizedDockerOptionsText?: string;
  silent?: boolean;
  verbose?: boolean;
};

export function normalizeArgs(
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof scriptOptionsBuilder>>>
): void {
  (argv as ScriptArgv).normalizedArgsText = [...(argv.args ?? []), ...(argv._?.slice(1) ?? [])]
    .map((arg) => `'${arg}'`)
    .join(' ');
  (argv as ScriptArgv).normalizedDockerOptionsText = (argv.dockerOptions ?? []).map((arg) => `'${arg}'`).join(' ');
}

export function toDevNull(argv: unknown): string {
  return (argv as { silent: boolean }).silent ? ` > /dev/null` : '';
}
