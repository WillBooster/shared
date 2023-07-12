export const preprocessedOptions = {
  env: {
    description: '.env files to be loaded.',
    type: 'array',
  },
  cascade: {
    description:
      'environment to load cascading .env files (e.g., `.env`, `.env.<environment>`, `.env.local` and `.env.<environment>.local`)',
    type: 'string',
  },
  'node-env': {
    description:
      'environment to load cascading .env files (e.g., `.env`, `.env.<NODE_ENV>`, `.env.local` and `.env.<NODE_ENV>.local`). Preferred over `cascade`.',
    type: 'boolean',
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
