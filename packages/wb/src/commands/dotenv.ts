import { spawn } from 'node:child_process';
import path from 'node:path';

import { readFnoxEnvironmentVariables, removeNpmAndYarnEnvironmentVariables } from '@willbooster/shared-lib-node/src';
import { expand } from 'dotenv-expand';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

import { prependNodeModulesBinToPath } from '../utils/binPath.js';
import { isCI } from '../utils/ci.js';

interface ParsedDotenvArgs {
  command: string[];
}

interface CommandEnvironment {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const shutdownSignals = new Set<NodeJS.Signals>(['SIGINT', 'SIGTERM', 'SIGQUIT']);

export const dotenvCommand: CommandModule = {
  command: 'dotenv [args..]',
  describe: 'Load environment variables from fnox and run a command.',
  builder: (yargs: Argv<unknown>) => yargs.parserConfiguration({ 'populate--': true }),
  async handler(argv) {
    await runParsedDotenvCommand(getParsedDotenvArgsFromYargs(argv));
  },
};

async function runParsedDotenvCommand({ command }: ParsedDotenvArgs): Promise<void> {
  await runCommandWithEnvironment(command, 'wb dotenv -- <command> [args...]');
}

export async function runCommandWithEnvironment(
  command: string[],
  usage: string,
  commandEnvironment?: CommandEnvironment
): Promise<void> {
  if (command.length === 0) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }

  const cwd = path.resolve(commandEnvironment?.cwd ?? process.cwd());
  const env = commandEnvironment?.env ?? process.env;
  if (!commandEnvironment) readAndApplyEnvironmentVariables(cwd);
  const berryBinFolderPath = env.BERRY_BIN_FOLDER;
  removeNpmAndYarnEnvironmentVariables(env);
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
  if (!prependNodeModulesBinToPath(cwd, env) && berryBinFolderPath) {
    env.PATH = env.PATH ? `${berryBinFolderPath}:${env.PATH}` : berryBinFolderPath;
  }

  await new Promise<void>((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env,
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
      process.exitCode = code ?? 1;
      resolve();
    });
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

function validateStandardWbEnv(value: string | undefined, fixTarget: string): void {
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

// NOTE: `wb dotenv` deliberately skips Project.env's full validation: it is a generic runner also
// used before env sources exist (bootstrap) and must not fail fast for repositories that have not
// adopted the org env standard. A NON-EMPTY WB_ENV is still validated against the standard modes,
// though — a typo like `prodcution` would otherwise silently select the base (development) values.
function readAndApplyEnvironmentVariables(cwd: string): void {
  // The mode is FORCED only when WB_ENV is explicitly exported; it drives the forced-mode override
  // below and the validation at the end.
  const mode = process.env.WB_ENV;
  // The fnox `--profile` selector, defaulting to development like wb's main loader (`WB_ENV ||
  // NODE_ENV || 'development'`, see readEnvironmentVariables) so a repo keeping dev-only secrets
  // in `[profiles.development.secrets]` loads them when WB_ENV is unset instead of only the base
  // table. It additionally honors an explicit FNOX_PROFILE, because fnox honors it and `wb dotenv`
  // without WB_ENV is documented to as well (see runFnoxExport's ignoreProfileEnvVar note).
  // NODE_ENV is read through the `runtimeEnv` alias, never as the `process.env.NODE_ENV` member
  // expression that the bundler inlines to 'production' (which would wrongly select production).
  const runtimeEnv = process.env;
  const fnoxCascade = mode || runtimeEnv.FNOX_PROFILE || runtimeEnv.NODE_ENV || 'development';
  // WB_ENV in process.env means the mode is explicitly forced, so values from the mode's own fnox
  // profile win over variables inherited from the parent shell — except on CI, where injected env
  // vars must keep overriding committed values
  // (see https://github.com/WillBooster/shared/issues/930).
  const modeFileOverridesProcessEnv = !!mode && !isCI(process.env.CI);
  const [parsed] = readFnoxEnvironmentVariables(cwd, fnoxCascade, { modeFileOverridesProcessEnv });
  // Expand ${...} references against exported variables whose fnox value loses to the shell
  // (mirroring readEnvironmentVariables' effective-value semantics): a reference must resolve to
  // the value the child will actually see. readFnoxEnvironmentVariables returns a
  // process.env-shadowed key only when the forced profile overrides it, so every parsed key's own
  // value wins and is excluded from the reference set.
  const referenceEnv: Record<string, string> = {};
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
  // child will see — the fnox profile may define a broken WB_ENV (e.g. `prodcution`), and a forced
  // mode's profile may even override a VALID exported value.
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
