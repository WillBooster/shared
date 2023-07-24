export const preprocessedOptions = {
  env: {
    description: '.env files to be loaded.',
    type: 'array',
  },
  'cascade-env': {
    description:
      'environment to load cascading .env files (e.g., `.env`, `.env.<environment>`, `.env.local` and `.env.<environment>.local`)',
    type: 'string',
  },
  'cascade-node-env': {
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
