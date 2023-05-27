export const preprocessedOptions = {
  env: {
    description: '.env files to be loaded.',
    type: 'array',
    alias: 'e',
  },
  'working-dir': {
    description: 'A working directory',
    type: 'string',
    alias: 'w',
  },
} as const;

export const sharedOptions = {
  dry: {
    description: 'Indicates if dry-run mode is enabled or not.',
    type: 'boolean',
    alias: 'd',
  },
  verbose: {
    description: 'Indicates if verbose mode is enabled or not.',
    type: 'boolean',
    alias: 'v',
  },
} as const;
