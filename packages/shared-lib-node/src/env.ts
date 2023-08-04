import path from 'node:path';

import { config } from 'dotenv';

interface Options {
  env?: (string | number)[];
  cascadeEnv?: string;
  cascadeNodeEnv?: boolean;
  verbose?: boolean;
}

export const yargsOptionsBuilderForEnv = {
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
      'environment to load cascading .env files (e.g., `.env`, `.env.<NODE_ENV>`, `.env.local` and `.env.<NODE_ENV>.local`). If NODE_ENV is falsy, "development" is applied. Preferred over `cascade`.',
    type: 'boolean',
  },
} as const;

/**
 * This function loads environment variables from `.env` files.
 * */
export function loadEnvironmentVariables(argv: Options, cwd: string): Record<string, string> {
  let envPaths = (argv.env ?? []).map((envPath) => envPath.toString());
  const cascade = argv.cascadeNodeEnv ? process.env.NODE_ENV || 'development' : argv.cascadeEnv;
  if (typeof cascade === 'string') {
    if (envPaths.length === 0) envPaths.push('.env');
    envPaths = envPaths.flatMap((envPath) =>
      cascade
        ? [`${envPath}.${cascade}.local`, `${envPath}.local`, `${envPath}.${cascade}`, envPath]
        : [`${envPath}.local`, envPath]
    );
  }
  if (argv.verbose) {
    console.info('Loading env files:', envPaths);
  }

  let envVars = {};
  for (const envPath of envPaths) {
    envVars = { ...config({ path: path.join(cwd, envPath) }).parsed, ...envVars };
  }
  return envVars;
}

/**
 * This function removes environment variables related to npm and yarn from the given environment variables.
 * */
export function removeNpmAndYarnEnvironmentVariables(envVars: Record<string, string | undefined>): void {
  // Remove npm & yarn environment variables from process.env
  if (envVars.PATH && envVars.BERRY_BIN_FOLDER) {
    envVars.PATH = envVars.PATH.replace(`${envVars.BERRY_BIN_FOLDER}:`, '')
      // Temporary directory in macOS
      .replaceAll(/\/private\/var\/folders\/[^:]+:/g, '')
      // Temporary directories in Linux
      .replaceAll(/\/var\/tmp\/[^:]+:/g, '')
      .replaceAll(/\/tmp\/[^:]+:/g, '');
  }
  for (const key of Object.keys(envVars)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith('npm_') || lowerKey.startsWith('yarn_') || lowerKey.startsWith('berry_')) {
      delete envVars[key];
    }
  }
}
