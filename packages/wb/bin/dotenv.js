import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expand } from 'dotenv-expand';

const shutdownSignals = new Set(['SIGINT', 'SIGTERM', 'SIGQUIT']);

export function runDotenvCommand(args) {
  const { command } = parseDotenvArgs(args);
  runCommandWithEnvironment(command, 'wb dotenv -- <command> [args...]');
}

function runCommandWithEnvironment(command, usage) {
  if (command.length === 0) {
    console.error(`Usage: ${usage}`);
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
  child.on('error', (error) => {
    console.error(error);
    process.exit(1);
  });
  for (const signal of shutdownSignals) {
    const signalHandler = () => {
      child.kill(signal);
    };
    signalHandlers.set(signal, signalHandler);
    process.once(signal, signalHandler);
  }
  child.on('exit', (code, signal) => {
    for (const [shutdownSignal, signalHandler] of signalHandlers) {
      process.off(shutdownSignal, signalHandler);
    }
    if (signal) {
      // Re-raise even for forwarded shutdown signals so callers observe the conventional
      // signal exit status (e.g. 130 for SIGINT) instead of a misleading success.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

// Mirrors src/commands/dotenv.ts (validateStandardWbEnv) for this startup fast path.
function validateStandardWbEnv(value, fixTarget) {
  if (
    !value ||
    ['development', 'test', 'staging', 'production'].includes(value) ||
    process.env.WB_SKIP_ENV_CHECK === '1' ||
    process.env.WB_SKIP_ENV_CHECK === 'true'
  ) {
    return;
  }
  console.error(
    `WB_ENV must be one of development, test, staging, or production, but is "${value}". ` +
      `Fix ${fixTarget}, or set WB_SKIP_ENV_CHECK=1 to skip this check.`
  );
  process.exit(1);
}

// Mirrors src/commands/dotenv.ts (readAndApplyEnvironmentVariables) for this startup fast path.
function readAndApplyEnvironmentVariables(cwd) {
  // The mode is FORCED only when WB_ENV is explicitly exported; it drives the forced-mode override
  // below and the validation at the end.
  const mode = process.env.WB_ENV;
  // The fnox `--profile` selector, defaulting to development like wb's main loader (`WB_ENV ||
  // NODE_ENV || 'development'`) so a repo keeping dev-only secrets in
  // `[profiles.development.secrets]` loads them when WB_ENV is unset instead of only the base
  // table. It additionally honors an explicit FNOX_PROFILE, because fnox honors it and
  // `wb dotenv` without WB_ENV is documented to as well.
  const fnoxCascade = mode || process.env.FNOX_PROFILE || process.env.NODE_ENV || 'development';
  // WB_ENV in process.env means the mode is explicitly forced, so values from the mode's own fnox
  // profile win over variables inherited from the parent shell — except on CI, where injected env
  // vars must keep overriding committed values
  // (see https://github.com/WillBooster/shared/issues/930).
  const modeFileOverridesProcessEnv = !!mode && !isCI(process.env.CI);
  const parsed = readFnoxEnvironmentVariables(cwd, fnoxCascade, modeFileOverridesProcessEnv);
  // Expand ${...} references against exported variables whose fnox value loses to the shell
  // (mirroring readEnvironmentVariables' effective-value semantics): a reference must resolve to
  // the value the child will actually see. readFnoxEnvironmentVariables returns a
  // process.env-shadowed key only when the forced profile overrides it, so every parsed key's own
  // value wins and is excluded from the reference set.
  const referenceEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Escape dollar signs so exported values substitute literally (pa$word stays pa$word).
    if (value !== undefined && !(key in parsed)) {
      referenceEnv[key] = value.replaceAll('$', String.raw`\$`);
    }
  }
  const envVars = expand({ parsed, processEnv: referenceEnv }).parsed ?? parsed;
  for (const [key, value] of Object.entries(envVars)) {
    if (!(key in process.env)) {
      process.env[key] = value;
      continue;
    }
    if (process.env[key] === value) continue;
    // A process.env-shadowed key reaches here only when the forced profile overrides it (see
    // readFnoxEnvironmentVariables); on CI such keys are never returned, so no branch is needed.
    if (modeFileOverridesProcessEnv) {
      console.warn(
        `Warning: ${key} in the "${mode}" mode's env sources overrides the value inherited from the parent environment because WB_ENV is explicitly set.`
      );
      process.env[key] = value;
    }
  }
  // Validate only AFTER applying the sources, so a WB_SKIP_ENV_CHECK defined in an env SOURCE is
  // honored: both the captured exported mode (it selected the profile) and the FINAL value the
  // child will see.
  validateStandardWbEnv(mode, 'the exported variable');
  validateStandardWbEnv(process.env.WB_ENV, 'the env source or the exported variable');
  // The selected environment is what an env source silently resolving WB_ENV to a DIFFERENT value
  // must agree with, else the child runs labeled one environment while carrying another's secrets.
  // Only a STANDARD cascade is enforced (mirroring Project.completeAndValidateWbEnv): a custom
  // selector such as `NODE_ENV=qa` legitimately selects the `qa` profile while WB_ENV stays a
  // standard mode.
  const expectedCascade = fnoxCascade;
  if (
    process.env.WB_ENV &&
    ['development', 'test', 'staging', 'production'].includes(expectedCascade) &&
    process.env.WB_ENV !== expectedCascade &&
    process.env.WB_SKIP_ENV_CHECK !== '1' &&
    process.env.WB_SKIP_ENV_CHECK !== 'true'
  ) {
    console.error(
      `WB_ENV resolves to "${process.env.WB_ENV}" although the "${expectedCascade}" environment was selected. ` +
        `Fix the WB_ENV defined in the env sources, or set WB_SKIP_ENV_CHECK=1 to skip this check.`
    );
    process.exit(1);
  }
}

// Mirrors readFnoxEnvironmentVariables in @willbooster/shared-lib-node for this startup fast path.
function readFnoxEnvironmentVariables(cwd, cascade, modeFileOverridesProcessEnv) {
  if (!hasProjectFnoxConfig(cwd)) return {};

  const secrets = runFnoxExport(cwd, cascade, { quiet: false });
  if (!secrets) return {};
  // A key is profile-specific (and may override process.env off CI) when the profile export's
  // value differs from the base export's; when the base export fails, no override is applied.
  // The base export runs lazily, only when a process.env collision needs adjudicating.
  let cachedBaseSecrets = false;
  const getBaseSecrets = () => {
    if (cachedBaseSecrets === false) {
      cachedBaseSecrets = runFnoxExport(cwd, undefined, { quiet: true, ignoreProfileEnvVar: true });
    }
    return cachedBaseSecrets;
  };

  const envVars = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value !== 'string') continue;
    if (key in process.env) {
      const baseSecrets = modeFileOverridesProcessEnv && cascade ? getBaseSecrets() : undefined;
      const overridesProcessEnv = baseSecrets !== undefined && baseSecrets[key] !== value;
      if (!overridesProcessEnv) continue;
    }
    envVars[key] = value;
  }
  return envVars;
}

function runFnoxExport(cwd, cascade, options) {
  // `--if-missing error`: fnox otherwise exits 0 and silently omits secrets it fails to resolve.
  // `--non-interactive`: prompts or browser auth flows would hang forever because stdin is ignored.
  const args = ['export', '--format', 'json', '--no-color', '--if-missing', 'error', '--non-interactive'];
  const env = { ...process.env };
  if (cascade) {
    args.push('--profile', cascade);
  }
  if (options.ignoreProfileEnvVar) {
    // Without `--profile`, fnox falls back to FNOX_PROFILE; the base-adjudication export must
    // read the BASE secrets, so the inherited profile selection is cleared for it — and only for
    // it. A PRIMARY export still honors FNOX_PROFILE: it either stays profile-less (fnox reads the
    // variable) or folds it into the `--profile` it passes (see wb dotenv's cascade).
    delete env.FNOX_PROFILE;
  }
  const result = childProcess.spawnSync('fnox', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    if (!options.quiet) {
      console.warn(
        `Failed to read fnox secrets: ${result.error?.message || result.stderr?.trim() || `fnox exited with status ${result.status}`}`
      );
    }
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return;
  }
  const secrets = parsed?.secrets;
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) return;
  return secrets;
}

// Mirrors src/utils/ci.ts for this startup fast path.
function isCI(ciEnv) {
  return !!ciEnv && ciEnv !== '0' && ciEnv !== 'false';
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
