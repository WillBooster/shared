import path from 'node:path';

import { config } from 'dotenv';

interface Options {
  env?: (string | number)[];
  cascadeEnv?: string;
  cascadeNodeEnv?: boolean;
  autoCascadeEnv?: boolean;
  checkEnv?: string;
  verbose?: boolean;
}

export const yargsOptionsBuilderForEnv = {
  env: {
    description: '.env files to be loaded.',
    type: 'array',
  },
  'cascade-env': {
    description:
      'Environment to load cascading .env files (e.g., `.env`, `.env.<environment>`, `.env.local` and `.env.<environment>.local`). Preferred over `cascade-node-env` and `auto-cascade-env`.',
    type: 'string',
  },
  'cascade-node-env': {
    description:
      'Same with --cascade-env=<NODE_ENV>. If NODE_ENV is falsy, "development" is applied. Preferred over `auto-cascade-env`.',
    type: 'boolean',
  },
  'auto-cascade-env': {
    description:
      'Same with --cascade-env=<WB_ENV || APP_ENV || NODE_ENV>. If they are falsy, "development" is applied.',
    type: 'boolean',
    default: true,
  },
  'check-env': {
    description: 'Check whether the keys of the loaded .env files are same with the given .env file.',
    type: 'string',
    default: '.env.example',
  },
} as const;

/**
 * This function loads environment variables from `.env` files.
 * */
export function loadEnvironmentVariables(argv: Options, cwd: string): Record<string, string> {
  let envPaths = (argv.env ?? []).map((envPath) => envPath.toString());
  const cascade =
    argv.cascadeEnv ??
    (argv.cascadeNodeEnv
      ? process.env.NODE_ENV || 'development'
      : argv.autoCascadeEnv
      ? process.env.WB_ENV || process.env.APP_ENV || process.env.NODE_ENV || 'development'
      : undefined);
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

  if (argv.checkEnv) {
    const exampleKeys = Object.keys(config({ path: path.join(cwd, argv.checkEnv) }).parsed || {});
    for (const key of exampleKeys) {
      if (!(key in envVars)) {
        throw new Error(`Missing environment variable: ${key}`);
      }
    }
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
    const upperKey = key.toUpperCase();
    if (
      upperKey.startsWith('NPM_') ||
      upperKey.startsWith('YARN_') ||
      upperKey.startsWith('BERRY_') ||
      upperKey === 'PROJECT_CWD' ||
      upperKey === 'INIT_CWD'
    ) {
      delete envVars[key];
    }
  }
}
