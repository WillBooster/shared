import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';

import { config } from 'dotenv';
import { expand } from 'dotenv-expand';
import type { ArgumentsCamelCase, InferredOptionTypes } from 'yargs';

export const yargsOptionsBuilderForEnv = {
  env: {
    description: '.env files to be loaded.',
    nargs: 1,
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
  'quiet-env': {
    description: 'Suppress .env file loading information.',
    type: 'boolean',
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
 * @return [envVars, [envPaths, envVarNames][]]
 * */
export function readEnvironmentVariables(
  argv: EnvReaderOptions,
  cwd: string,
  options?: {
    /**
     * Load variables even if they already exist in process.env.
     * Useful when a parent process has already injected the .env values into the environment
     * and the file-defined variables themselves are needed (e.g. `wb gen-dev-vars`).
     */
    ignoreProcessEnv?: boolean;
  }
): [Record<string, string>, [string, string[]][]] {
  let envPaths = (argv.env ?? []).map((envPath) => path.resolve(cwd, envPath.toString()));
  const cascade =
    argv.cascadeEnv ??
    (argv.cascadeNodeEnv
      ? process.env.NODE_ENV || 'development'
      : argv.autoCascadeEnv
        ? process.env.WB_ENV || process.env.NODE_ENV || 'development'
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
  const shouldSuppressOutput = shouldSuppressEnvironmentOutput(argv);
  if (argv.verbose && !shouldSuppressOutput) {
    console.info(`WB_ENV: ${process.env.WB_ENV}, NODE_ENV: ${process.env.NODE_ENV}`);
    console.info('Reading env files:', envPaths.join(', '));
  }

  const envPathAndLoadedEnvVarNames: [string, string[]][] = [];
  const envVars: Record<string, string> = {};
  for (const envPath of envPaths) {
    const keys: string[] = [];
    for (const [key, value] of Object.entries(readEnvFile(path.join(cwd, envPath)))) {
      if (!(key in envVars) && (options?.ignoreProcessEnv || !(key in process.env))) {
        envVars[key] = value;
        keys.push(key);
      }
    }
    envPathAndLoadedEnvVarNames.push([envPath, keys]);
    if (argv.verbose && !shouldSuppressOutput && keys.length > 0) {
      console.info(`Read ${keys.length} environment variables from ${envPath}`);
    }
  }
  const [miseEnvVars, miseEnvVarNames] = readMiseEnvironmentVariables(cwd, cascade, envVars);
  Object.assign(envVars, miseEnvVars);
  if (miseEnvVarNames.length > 0) {
    envPathAndLoadedEnvVarNames.push([miseEnvironmentSourceName(cascade), miseEnvVarNames]);
    if (argv.verbose && !shouldSuppressOutput) {
      console.info(`Read ${miseEnvVarNames.length} environment variables from ${miseEnvironmentSourceName(cascade)}`);
    }
  }
  if (!argv.verbose && !shouldSuppressOutput) {
    console.info(
      `Read env files: ${envPathAndLoadedEnvVarNames.map(([envPath, keys]) => (keys.length > 0 ? `${envPath} (${keys.join(', ')})` : envPath)).join(', ') || 'nothing'}`
    );
  }

  if (argv.checkEnv) {
    const exampleKeys = Object.keys(readEnvFile(path.join(cwd, argv.checkEnv)));
    const missingKeys = exampleKeys.filter((key) => !(key in envVars) && !(key in process.env));
    if (missingKeys.length > 0) {
      throw new Error(`Missing environment variables in [${envPaths.join(', ')}]: [${missingKeys.join(', ')}]`);
    }
  }
  return [expand({ parsed: envVars, processEnv: {} }).parsed ?? envVars, envPathAndLoadedEnvVarNames];
}

function readMiseEnvironmentVariables(
  cwd: string,
  cascade: string | undefined,
  currentEnvVars: Record<string, string>
): [Record<string, string>, string[]] {
  if (!hasProjectMiseConfig(cwd)) return [{}, []];

  const args = ['env', '--json', '--cd', cwd];
  if (cascade) {
    args.push('--env', cascade);
  }
  const result = childProcess.spawnSync('mise', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) return [{}, []];

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [{}, []];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [{}, []];

  const envVars: Record<string, string> = {};
  const keys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue;
    if (key in currentEnvVars || process.env[key] === value) continue;
    envVars[key] = value;
    keys.push(key);
  }
  return [envVars, keys];
}

function hasProjectMiseConfig(cwd: string): boolean {
  for (let currentPath = path.resolve(cwd); ; currentPath = path.dirname(currentPath)) {
    if (fs.existsSync(path.join(currentPath, 'mise.toml')) || fs.existsSync(path.join(currentPath, '.mise.toml'))) {
      return true;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return false;
  }
}

function miseEnvironmentSourceName(cascade: string | undefined): string {
  return cascade ? `mise env --env ${cascade}` : 'mise env';
}

export function shouldSuppressEnvironmentOutput(argv: EnvReaderOptions): boolean {
  const outputOptions = argv as EnvReaderOptions & { quietEnv?: boolean; silent?: boolean };
  return outputOptions.quietEnv === true || (outputOptions.quietEnv !== false && outputOptions.silent === true);
}

/**
 * This function read environment variables from `.env` files and assign them in `process.env`.
 * */
export function readAndApplyEnvironmentVariables(
  argv: EnvReaderOptions,
  cwd: string
): Record<string, string | undefined> {
  const [envVars] = readEnvironmentVariables(argv, cwd);
  for (const [key, value] of Object.entries(envVars)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
  return envVars;
}

const cachedEnvVars = new Map<string, Record<string, string>>();

function readEnvFile(filePath: string): Record<string, string> {
  const cached = cachedEnvVars.get(filePath);
  if (cached) return cached;

  const parsed = config({ path: path.resolve(filePath), processEnv: {}, quiet: true }).parsed ?? {};
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
