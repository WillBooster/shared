import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { config } from 'dotenv';
import { expand } from 'dotenv-expand';

const shutdownSignals = new Set(['SIGINT', 'SIGTERM', 'SIGQUIT']);

export function runDotenvCommand(args) {
  const { command } = parseDotenvArgs(args);
  if (command.length === 0) {
    console.error('Usage: wb dotenv -- <command> [args...]');
    process.exit(1);
  }

  const cwd = path.resolve(process.cwd());
  readAndApplyEnvironmentVariables(cwd);
  const berryBinFolderPath = process.env.BERRY_BIN_FOLDER;
  removeNpmAndYarnEnvironmentVariables(process.env);
  // Stripping yarn's environment also removes its temporary bin folder — the ONLY place
  // yarn Berry exposes dependency executables — so restore the project's own
  // node_modules/.bin directories (nearest first) to keep bare binary names resolvable.
  // Plug'n'Play installs create no node_modules at all; the temporary bin folder is then the
  // sole source of dependency executables, so restore it instead. Mirrors
  // src/commands/dotenv.ts + src/utils/binPath.ts for this startup fast path.
  // The temporary folder is deliberately NOT restored when .bin directories exist: it also
  // contains node/yarn shims, and a leaked node shim would violate wb's real-Node guarantee
  // for tools like wrangler/vinext. Child `yarn` invocations stay resolvable through the
  // launcher on the base PATH (mise/corepack), which every supported environment has —
  // nothing could have started `yarn run`/`wb dotenv` without it.
  if (!prependNodeModulesBinToPath(cwd, process.env) && berryBinFolderPath) {
    process.env.PATH = process.env.PATH ? `${berryBinFolderPath}:${process.env.PATH}` : berryBinFolderPath;
  }

  const child = childProcess.spawn(command[0], command.slice(1), {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  const signalHandlers = new Map();
  let forwardedShutdownSignal;
  child.on('error', (error) => {
    console.error(error);
    process.exit(1);
  });
  for (const signal of shutdownSignals) {
    const signalHandler = () => {
      forwardedShutdownSignal = signal;
      child.kill(signal);
    };
    signalHandlers.set(signal, signalHandler);
    process.once(signal, signalHandler);
  }
  child.on('exit', (code, signal) => {
    for (const [shutdownSignal, signalHandler] of signalHandlers) {
      process.off(shutdownSignal, signalHandler);
    }
    if (signal && signal === forwardedShutdownSignal) {
      process.exit(0);
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

function readAndApplyEnvironmentVariables(cwd) {
  const dotenvVars = {
    ...readEnvFile(path.join(cwd, '.env')),
    ...(process.env.WB_ENV ? readEnvFile(path.join(cwd, `.env.${process.env.WB_ENV}`)) : {}),
  };
  // fnox.toml is the committed, encrypted equivalent of .env files; local .env files still win
  // over it. Mirrors src/commands/dotenv.ts for this startup fast path.
  const parsed = { ...readFnoxEnvironmentVariables(cwd, process.env.WB_ENV, dotenvVars), ...dotenvVars };
  const envVars = expand({ parsed, processEnv: {} }).parsed ?? parsed;
  for (const [key, value] of Object.entries(envVars)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Mirrors readFnoxEnvironmentVariables in @willbooster/shared-lib-node for this startup fast path.
function readFnoxEnvironmentVariables(cwd, cascade, currentEnvVars) {
  if (!hasProjectFnoxConfig(cwd)) return {};

  // `--if-missing error`: fnox otherwise exits 0 and silently omits secrets it fails to resolve.
  // `--non-interactive`: prompts or browser auth flows would hang forever because stdin is ignored.
  const args = ['export', '--format', 'json', '--no-color', '--if-missing', 'error', '--non-interactive'];
  if (cascade) {
    args.push('--profile', cascade);
  }
  const result = childProcess.spawnSync('fnox', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    console.warn(
      `Failed to read fnox secrets: ${result.error?.message || result.stderr?.trim() || `fnox exited with status ${result.status}`}`
    );
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {};
  }
  const secrets = parsed?.secrets;
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) return {};

  const envVars = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value !== 'string' || key in currentEnvVars || key in process.env) continue;
    envVars[key] = value;
  }
  return envVars;
}

function hasProjectFnoxConfig(cwd) {
  for (let currentPath = path.resolve(cwd); ; currentPath = path.dirname(currentPath)) {
    if (fs.existsSync(path.join(currentPath, 'fnox.toml'))) {
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

function prependNodeModulesBinToPath(dirPath, env) {
  const binPaths = [];
  let currentPath = path.resolve(dirPath);
  for (;;) {
    const binPath = path.join(currentPath, 'node_modules', '.bin');
    if (fs.existsSync(binPath)) {
      binPaths.push(binPath);
    }

    if (fs.existsSync(path.join(currentPath, '.git'))) {
      break;
    }
    const parentPath = path.dirname(currentPath);
    if (currentPath === parentPath) {
      break;
    }
    currentPath = parentPath;
  }
  if (binPaths.length === 0) return false;
  env.PATH = env.PATH ? `${binPaths.join(':')}:${env.PATH}` : binPaths.join(':');
  return true;
}

function parseDotenvArgs(args) {
  const separatorIndex = args.indexOf('--');
  return { command: separatorIndex === -1 ? args : args.slice(separatorIndex + 1) };
}
