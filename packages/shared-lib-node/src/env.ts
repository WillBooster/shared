import path from 'node:path';

import { config } from 'dotenv';

interface Options {
  env?: (string | number)[];
  cascadeEnv?: string;
  cascadeNodeEnv?: boolean;
  verbose?: boolean;
}

/**
 * This function loads environment variables from `.env` files.
 * */
export function loadEnvironmentVariables(argv: Options, cwd: string): Record<string, string> {
  let envPaths = (argv.env ?? []).map((envPath) => envPath.toString());
  const cascade = argv.cascadeNodeEnv ? process.env.NODE_ENV ?? '' : argv.cascadeEnv;
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
export function removeNpmAndYarnEnvironmentVariables(envVars: Record<string, unknown>): void {
  // Remove npm & yarn environment variables from process.env
  for (const key of Object.keys(envVars)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith('npm_') || lowerKey.startsWith('yarn_') || lowerKey.startsWith('berry_')) {
      delete envVars[key];
    }
  }
}
