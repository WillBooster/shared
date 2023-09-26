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
    description: 'Same with --cascade-env=<NODE_ENV || "development">. Preferred over `auto-cascade-env`.',
    type: 'boolean',
  },
  'auto-cascade-env': {
    description: 'Same with --cascade-env=<WB_ENV || APP_ENV || NODE_ENV || "">.',
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
export function loadEnvironmentVariables(argv: Options, cwd: string, orgCwd?: string): Record<string, string> {
  let envPaths = (argv.env ?? []).map((envPath) => path.resolve(orgCwd ?? cwd, envPath.toString()));
  const cascade =
    argv.cascadeEnv ??
    (argv.cascadeNodeEnv
      ? process.env.NODE_ENV || 'development'
      : argv.autoCascadeEnv
      ? process.env.WB_ENV || process.env.APP_ENV || process.env.NODE_ENV || 'development'
      : undefined);
  if (typeof cascade === 'string') {
    if (envPaths.length === 0) envPaths.push(path.join(cwd, '.env'));
    envPaths = envPaths.flatMap((envPath) =>
      cascade
        ? [`${envPath}.${cascade}.local`, `${envPath}.local`, `${envPath}.${cascade}`, envPath]
        : [`${envPath}.local`, envPath]
    );
  }
  envPaths = envPaths.map((envPath) => path.relative(cwd, envPath));
  if (argv.verbose) {
    console.info('Loading env files:', envPaths);
  }

  let envVars: Record<string, string> = {};
  const orgEnvVars = { ...process.env };
  for (const envPath of envPaths) {
    envVars = { ...config({ path: path.join(cwd, envPath) }).parsed, ...envVars };
    let count = 0;
    for (const [key, value] of Object.entries(envVars)) {
      if (orgEnvVars[key] !== value) {
        orgEnvVars[key] = value;
        count++;
      }
    }
    if (count > 0) {
      console.info(`Updated ${count} environment variables:`, envPath);
    }
  }

  if (argv.checkEnv) {
    const exampleKeys = Object.keys(config({ path: path.join(cwd, argv.checkEnv) }).parsed || {});
    const missingKeys = exampleKeys.filter((key) => !(key in envVars));
    if (missingKeys.length > 0) {
      throw new Error(`Missing environment variables in [${envPaths.join(', ')}]: [${missingKeys.join(', ')}]`);
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
