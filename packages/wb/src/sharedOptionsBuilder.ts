import { yargsOptionsBuilderForEnv } from '@willbooster/shared-lib-node/src';
import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';

export const sharedOptionsBuilder = {
  ...yargsOptionsBuilderForEnv,
  // This option is for debugging mainly.
  'working-dir': {
    description: 'A working directory',
    type: 'string',
    alias: 'w',
  },
  'dry-run': {
    description: 'Whether to skip actual command execution',
    type: 'boolean',
    alias: ['dry', 'd'],
  },
} as const;

export function buildEnvReaderOptionArgs(argv: EnvReaderOptions): string[] {
  const args: string[] = [];
  for (const optionName of Object.keys(yargsOptionsBuilderForEnv)) {
    const value = getOptionValue(argv, optionName);
    if (value === undefined) continue;

    if (typeof value === 'boolean') {
      args.push(value ? `--${optionName}` : `--${optionName}=false`);
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      args.push(`--${optionName}=${value}`);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        args.push(`--${optionName}=${item}`);
      }
    }
  }
  return args;
}

function getOptionValue(argv: EnvReaderOptions, optionName: string): unknown {
  const camelCaseOptionName = optionName.replaceAll(/-([a-z])/g, (_, character: string) => character.toUpperCase());
  const options = argv as Record<string, unknown>;
  return options[optionName] ?? options[camelCaseOptionName];
}
