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
  verbose: {
    description: 'Whether or not verbose mode is enabled.',
    type: 'boolean',
    alias: 'v',
  },
} as const;
