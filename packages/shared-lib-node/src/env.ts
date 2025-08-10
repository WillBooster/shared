import fs from 'node:fs';
import path from 'node:path';

import { config } from 'dotenv';
import type { ArgumentsCamelCase, InferredOptionTypes } from 'yargs';

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
    description: 'Same with --cascade-env=<WB_ENV || NODE_ENV || "development">.',
    type: 'boolean',
    default: true,
  },
  'include-root-env': {
    description: 'Include .env files in root directory if the project is in a monorepo and --env option is not used.',
    type: 'boolean',
    default: true,
  },
  'check-env': {
    description: 'Check whether the keys of the loaded .env files are same with the given .env file.',
    type: 'string',
    default: '.env.example',
  },
  verbose: {
    description: 'Whether to show verbose information',
    type: 'boolean',
    alias: 'v',
  },
} as const;

export type EnvReaderOptions = Partial<ArgumentsCamelCase<InferredOptionTypes<typeof yargsOptionsBuilderForEnv>>>;

/**
 * This function reads environment variables from `.env` files.
 * Note it does not assign them in `process.env`.
 * @return [envVars, [envPaths, envVarCount][]]
 * */
export function readEnvironmentVariables(
  argv: EnvReaderOptions,
  cwd: string
): [Record<string, string>, [string, number][]] {
  let envPaths = (argv.env ?? []).map((envPath) => path.resolve(cwd, envPath.toString()));
  const cascade =
    argv.cascadeEnv ??
    (argv.cascadeNodeEnv
      ? (process.env.NODE_ENV ?? 'development')
      : argv.autoCascadeEnv
        ? (process.env.WB_ENV ?? process.env.NODE_ENV ?? 'development')
        : undefined);
  if (typeof cascade === 'string') {
    if (envPaths.length === 0) {
      envPaths.push(path.join(cwd, '.env'));
      if (argv.includeRootEnv) {
        const rootPath = path.resolve(cwd, '..', '..');
        if (fs.existsSync(path.join(rootPath, 'package.json'))) {
          envPaths.push(path.join(rootPath, '.env'));
        }
      }
    }
    envPaths = envPaths.flatMap((envPath) =>
      cascade
        ? [`${envPath}.${cascade}.local`, `${envPath}.local`, `${envPath}.${cascade}`, envPath]
        : [`${envPath}.local`, envPath]
    );
  }
  envPaths = envPaths.filter((envPath) => fs.existsSync(envPath)).map((envPath) => path.relative(cwd, envPath));
  if (argv.verbose) {
    console.info(`WB_ENV: ${process.env.WB_ENV}, NODE_ENV: ${process.env.NODE_ENV}`);
    console.info('Reading env files:', envPaths.join(', '));
  }

  const envPathAndEnvVarCountPairs: [string, number][] = [];
  const envVars: Record<string, string> = {};
  for (const envPath of envPaths) {
    let count = 0;
    for (const [key, value] of Object.entries(readEnvFile(path.join(cwd, envPath)))) {
      if (!(key in envVars)) {
        envVars[key] = value;
        count++;
      }
    }
    envPathAndEnvVarCountPairs.push([envPath, count]);
    if (argv.verbose && count > 0) {
      console.info(`Read ${count} environment variables from ${envPath}`);
    }
  }

  if (argv.checkEnv) {
    const exampleKeys = Object.keys(readEnvFile(path.join(cwd, argv.checkEnv)));
    const missingKeys = exampleKeys.filter((key) => !(key in envVars));
    if (missingKeys.length > 0) {
      throw new Error(`Missing environment variables in [${envPaths.join(', ')}]: [${missingKeys.join(', ')}]`);
    }
  }
  return [envVars, envPathAndEnvVarCountPairs];
}

/**
 * This function read environment variables from `.env` files and assign them in `process.env`.
 * */
export function readAndApplyEnvironmentVariables(
  argv: EnvReaderOptions,
  cwd: string
): Record<string, string | undefined> {
  const [envVars] = readEnvironmentVariables(argv, cwd);
  Object.assign(process.env, envVars);
  return envVars;
}

const cachedEnvVars = new Map<string, Record<string, string>>();

function readEnvFile(filePath: string): Record<string, string> {
  const cached = cachedEnvVars.get(filePath);
  if (cached) return cached;

  const parsed = config({ path: path.resolve(filePath), processEnv: {} }).parsed ?? {};
  cachedEnvVars.set(filePath, parsed);
  return parsed;
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
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete envVars[key];
    }
  }
}
