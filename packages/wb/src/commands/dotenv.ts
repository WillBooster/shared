import { spawn } from 'node:child_process';
import path from 'node:path';

import { readFnoxEnvironmentVariables, removeNpmAndYarnEnvironmentVariables } from '@willbooster/shared-lib-node/src';
import { config } from 'dotenv';
import { expand } from 'dotenv-expand';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

import { prependNodeModulesBinToPath } from '../utils/binPath.js';
import { isCI } from '../utils/ci.js';

interface ParsedDotenvArgs {
  command: string[];
}

const shutdownSignals = new Set<NodeJS.Signals>(['SIGINT', 'SIGTERM', 'SIGQUIT']);

export const dotenvCommand: CommandModule = {
  command: 'dotenv [args..]',
  describe: 'Load .env files and run a command.',
  builder: (yargs: Argv<unknown>) => yargs.parserConfiguration({ 'populate--': true }),
  async handler(argv) {
    await runParsedDotenvCommand(getParsedDotenvArgsFromYargs(argv));
  },
};

export async function runDotenvCommand(args: string[]): Promise<void> {
  await runParsedDotenvCommand(parseDotenvArgs(args));
}

async function runParsedDotenvCommand({ command }: ParsedDotenvArgs): Promise<void> {
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
  // node_modules/.bin directories to keep bare binary names resolvable. Plug'n'Play installs
  // create no node_modules at all; the temporary bin folder is then the sole source of
  // dependency executables, so restore it instead.
  // The temporary folder is deliberately NOT restored when .bin directories exist: it also
  // contains node/yarn shims, and a leaked node shim would violate wb's real-Node guarantee
  // for tools like wrangler/vinext. Child `yarn` invocations stay resolvable through the
  // launcher on the base PATH (mise/corepack), which every supported environment has —
  // nothing could have started `yarn run`/`wb dotenv` without it.
  if (!prependNodeModulesBinToPath(cwd, process.env) && berryBinFolderPath) {
    process.env.PATH = process.env.PATH ? `${berryBinFolderPath}:${process.env.PATH}` : berryBinFolderPath;
  }

  const child = spawn(command[0]!, command.slice(1), {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  child.on('error', (error) => {
    console.error(error);
    process.exit(1);
  });
  for (const signal of shutdownSignals) {
    const signalHandler = (): void => {
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

function getParsedDotenvArgsFromYargs(argv: ArgumentsCamelCase): ParsedDotenvArgs {
  return {
    command: [
      ...((argv.args as unknown[] | undefined) ?? []).map(String),
      ...((argv['--'] as unknown[] | undefined) ?? []).map(String),
    ],
  };
}

function parseDotenvArgs(args: string[]): ParsedDotenvArgs {
  const separatorIndex = args.indexOf('--');
  return { command: separatorIndex === -1 ? args : args.slice(separatorIndex + 1) };
}

// NOTE: `wb dotenv` deliberately skips Project.env's full validation: it is a generic runner also
// used before env sources exist (bootstrap) and must not fail fast for repositories that have not
// adopted the org env standard. A NON-EMPTY WB_ENV is still validated against the standard modes,
// though — a typo like `prodcution` would otherwise silently select the base (development) values.
function readAndApplyEnvironmentVariables(cwd: string): void {
  const mode = process.env.WB_ENV;
  if (
    mode &&
    !['development', 'test', 'staging', 'production'].includes(mode) &&
    process.env.WB_SKIP_ENV_CHECK !== '1' &&
    process.env.WB_SKIP_ENV_CHECK !== 'true'
  ) {
    console.error(
      `WB_ENV must be one of development, test, staging, or production, but is "${mode}". ` +
        'Fix the exported variable, or set WB_SKIP_ENV_CHECK=1 to skip this check.'
    );
    process.exit(1);
  }
  const readEnvFile = (fileName: string): Record<string, string> =>
    config({ path: path.join(cwd, fileName), processEnv: {}, quiet: true }).parsed ?? {};
  // Mode-specific sources drive the forced-mode override below.
  const modeVars = mode ? { ...readEnvFile(`.env.${mode}`), ...readEnvFile(`.env.${mode}.local`) } : {};
  // Mirror the shared cascade's precedence: .env.<mode>.local > .env.local > .env.<mode> > .env.
  const dotenvVars = {
    ...readEnvFile('.env'),
    ...(mode ? readEnvFile(`.env.${mode}`) : {}),
    ...readEnvFile('.env.local'),
    ...(mode ? readEnvFile(`.env.${mode}.local`) : {}),
  };
  // WB_ENV in process.env means the mode is explicitly forced, so values from the mode's own
  // sources (.env.<mode>[.local] and the fnox profile) win over variables inherited from the
  // parent shell — except on CI, where injected env vars must keep overriding committed files
  // (see https://github.com/WillBooster/shared/issues/930).
  const modeFileOverridesProcessEnv = !!mode && !isCI(process.env.CI);
  // fnox.toml is the committed, encrypted equivalent of .env files; local .env files still win over it.
  const [fnoxVars] = readFnoxEnvironmentVariables(cwd, mode, dotenvVars, { modeFileOverridesProcessEnv });
  const parsed = { ...fnoxVars, ...dotenvVars };
  // Expand ${...} references against exported variables whose FILE value loses to the shell
  // (mirroring readEnvironmentVariables' effective-value semantics): a reference must resolve to
  // the value the child will actually see, so a shell-shadowed key expands to the shell value
  // while a winning file/override value expands to the file value.
  const fileValueWins = (key: string): boolean =>
    !(key in process.env) || (modeFileOverridesProcessEnv && (key in modeVars || key in fnoxVars));
  const referenceEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Escape dollar signs so exported values substitute literally (pa$word stays pa$word).
    if (value !== undefined && !(key in parsed && fileValueWins(key))) {
      referenceEnv[key] = value.replaceAll('$', String.raw`\$`);
    }
  }
  const envVars = expand({ parsed, processEnv: referenceEnv }).parsed ?? parsed;
  for (const [key, value] of Object.entries(envVars)) {
    if (!(key in process.env)) {
      process.env[key] = value;
      continue;
    }
    // readFnoxEnvironmentVariables returns a process.env-shadowed key only when the forced
    // profile overrides it, so fnox-provided keys count as mode-specific here.
    if (!(key in modeVars || key in fnoxVars) || process.env[key] === value) continue;

    if (modeFileOverridesProcessEnv) {
      console.warn(
        `Warning: ${key} in the "${mode}" mode's env sources overrides the value inherited from the parent environment because WB_ENV is explicitly set.`
      );
      process.env[key] = value;
    }
    // On CI, inherited variables intentionally win (workflows deliberately inject env vars that
    // override the committed files); this is the designed behavior, so no warning is emitted.
  }
}
