import { yargsOptionsBuilderForEnv } from '@willbooster/shared-lib-node/src';

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
