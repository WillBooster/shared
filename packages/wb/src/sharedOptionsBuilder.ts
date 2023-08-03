import { yargsOptionsBuilderForEnv } from '@willbooster/shared-lib-node/src';

export const sharedOptionsBuilder = {
  ...yargsOptionsBuilderForEnv,
  'working-dir': {
    description: 'A working directory',
    type: 'string',
    alias: 'w',
  },
  'dry-run': {
    description: 'Whether to skip actual command execution',
    type: 'boolean',
    alias: 'd',
  },
  verbose: {
    description: 'Whether to show verbose information',
    type: 'boolean',
    alias: 'v',
  },
} as const;
