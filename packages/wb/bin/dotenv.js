import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { config } from 'dotenv';
import { expand } from 'dotenv-expand';

export function runDotenvCommand(args) {
  const { command, options } = parseDotenvArgs(args);
  if (command.length === 0) {
    console.error('Usage: wb dotenv [-c <environment>] [--env <file>] -- <command> [args...]');
    process.exit(1);
  }

  const cwd = path.resolve(options.workingDir ?? process.cwd());
  if (options.workingDir) {
    process.chdir(cwd);
  }
  if (options.cascadeEnv) {
    process.env.WB_ENV ||= options.cascadeEnv;
  }
  readAndApplyEnvironmentVariables(options, cwd);
  removeNpmAndYarnEnvironmentVariables(process.env);

  const child = childProcess.spawn(command[0], command.slice(1), {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  child.on('error', (error) => {
    console.error(error);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

function readAndApplyEnvironmentVariables(options, cwd) {
  const envVars = readEnvironmentVariables(options, cwd);
  for (const [key, value] of Object.entries(envVars)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function readEnvironmentVariables(options, cwd) {
  let envPaths = (options.env ?? []).map((envPath) => path.resolve(cwd, envPath));
  const cascade =
    options.cascadeEnv ??
    (options.cascadeNodeEnv
      ? process.env.NODE_ENV || 'development'
      : options.autoCascadeEnv
        ? process.env.WB_ENV || process.env.NODE_ENV || 'development'
        : undefined);
  if (cascade) {
    if (envPaths.length === 0) {
      envPaths.push(path.join(cwd, '.env'));
      if (options.includeRootEnv ?? true) {
        const rootPath = path.resolve(cwd, '..', '..');
        if (fs.existsSync(path.join(rootPath, 'package.json'))) {
          envPaths.push(path.join(rootPath, '.env'));
        }
      }
    }
    envPaths = envPaths.flatMap((envPath) => [
      `${envPath}.${cascade}.local`,
      `${envPath}.local`,
      `${envPath}.${cascade}`,
      envPath,
    ]);
  }
  const envVars = {};
  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;

    for (const [key, value] of Object.entries(readEnvFile(envPath))) {
      if (!(key in envVars) && !(key in process.env)) {
        envVars[key] = value;
      }
    }
  }
  Object.assign(envVars, readMiseEnvironmentVariables(cwd, cascade, envVars));
  if (options.checkEnv) {
    const missingKeys = Object.keys(readEnvFile(path.join(cwd, options.checkEnv))).filter(
      (key) => !(key in envVars) && !(key in process.env)
    );
    if (missingKeys.length > 0) {
      throw new Error(`Missing environment variables: [${missingKeys.join(', ')}]`);
    }
  }
  return expand({ parsed: envVars, processEnv: {} }).parsed ?? envVars;
}

function readMiseEnvironmentVariables(cwd, cascadeEnv, currentEnvVars) {
  if (!hasProjectMiseConfig(cwd)) return {};

  const args = ['env', '--json', '--cd', cwd];
  if (cascadeEnv) {
    args.push('--env', cascadeEnv);
  }
  const result = childProcess.spawnSync('mise', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const envVars = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue;
    if (key in currentEnvVars || process.env[key] === value) continue;
    envVars[key] = value;
  }
  return envVars;
}

function hasProjectMiseConfig(cwd) {
  for (let currentPath = path.resolve(cwd); ; currentPath = path.dirname(currentPath)) {
    if (fs.existsSync(path.join(currentPath, 'mise.toml')) || fs.existsSync(path.join(currentPath, '.mise.toml'))) {
      return true;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return false;
  }
}

function readEnvFile(filePath) {
  return config({ path: path.resolve(filePath), processEnv: {}, quiet: true }).parsed ?? {};
}

function removeNpmAndYarnEnvironmentVariables(envVars) {
  if (envVars.PATH && envVars.BERRY_BIN_FOLDER) {
    envVars.PATH = envVars.PATH.replace(`${envVars.BERRY_BIN_FOLDER}:`, '')
      .replaceAll(/\/private\/var\/folders\/[^:]+:/g, '')
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

function parseDotenvArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      return normalizeParsedDotenvArgs({ command: args.slice(index + 1), options });
    }
    if (!arg.startsWith('-')) {
      return normalizeParsedDotenvArgs({ command: args.slice(index), options });
    }

    const nextValue = () => {
      const value = args[++index];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      return value;
    };
    if (arg === '-c' || arg === '--cascade-env') {
      options.cascadeEnv = nextValue();
    } else if (arg.startsWith('-c=')) {
      options.cascadeEnv = arg.slice('-c='.length);
    } else if (arg.startsWith('--cascade-env=')) {
      options.cascadeEnv = arg.slice('--cascade-env='.length);
    } else if (arg === '--cascade-node-env') {
      options.cascadeNodeEnv = true;
    } else if (arg === '--cascade-node-env=false' || arg === '--no-cascade-node-env') {
      options.cascadeNodeEnv = false;
    } else if (arg === '--auto-cascade-env') {
      options.autoCascadeEnv = true;
    } else if (arg === '--auto-cascade-env=false' || arg === '--no-auto-cascade-env') {
      options.autoCascadeEnv = false;
    } else if (arg === '-e' || arg === '--env') {
      options.env = [...(options.env ?? []), nextValue()];
    } else if (arg.startsWith('--env=')) {
      options.env = [...(options.env ?? []), arg.slice('--env='.length)];
    } else if (arg === '--check-env') {
      options.checkEnv = nextValue();
    } else if (arg.startsWith('--check-env=')) {
      options.checkEnv = arg.slice('--check-env='.length);
    } else if (arg === '--include-root-env') {
      options.includeRootEnv = true;
    } else if (arg === '--include-root-env=false' || arg === '--no-include-root-env') {
      options.includeRootEnv = false;
    } else if (arg === '--quiet' || arg === '--quiet-env') {
      options.quietEnv = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--working-dir') {
      options.workingDir = nextValue();
    } else if (arg.startsWith('--working-dir=')) {
      options.workingDir = arg.slice('--working-dir='.length);
    } else {
      throw new Error(`Unknown wb dotenv option: ${arg}`);
    }
  }
  return normalizeParsedDotenvArgs({ command: [], options });
}

function normalizeParsedDotenvArgs(parsed) {
  if (!parsed.options.cascadeEnv && !parsed.options.cascadeNodeEnv && !parsed.options.autoCascadeEnv && !parsed.options.env) {
    parsed.options.env = ['.env'];
  }
  return parsed;
}
