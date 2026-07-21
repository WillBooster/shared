import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  hasProjectFnoxConfig,
  readFnoxEnvironmentVariables,
  removeNpmAndYarnEnvironmentVariables,
} from '@willbooster/shared-lib-node/src';
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
  // Two selectors, both defaulting to development like wb's main loader (`WB_ENV || NODE_ENV ||
  // 'development'`, see readEnvironmentVariables) so a repo keeping dev-only secrets in
  // `[profiles.development.secrets]` loads them when WB_ENV is unset instead of only the base table:
  //   - envCascade picks the `.env.<envCascade>` files. It must NOT consult FNOX_PROFILE — that is a
  //     fnox-only selector, and letting it redirect a legacy `.env`-only project's cascade would load
  //     the wrong files.
  //   - fnoxCascade picks the fnox `--profile` and gates the WB_ENV check below. It additionally honors
  //     an explicit FNOX_PROFILE, because fnox honors it and `wb dotenv` without WB_ENV is documented
  //     to as well (see runFnoxExport's ignoreProfileEnvVar note).
  // NODE_ENV is read through the `runtimeEnv` alias, never as the `process.env.NODE_ENV` member
  // expression that the bundler inlines to 'production' (which would wrongly select production).
  const runtimeEnv = process.env;
  const envCascade = mode || runtimeEnv.NODE_ENV || 'development';
  const fnoxCascade = mode || runtimeEnv.FNOX_PROFILE || runtimeEnv.NODE_ENV || 'development';
  const readEnvFile = (fileName: string): Record<string, string> =>
    config({ path: path.join(cwd, fileName), processEnv: {}, quiet: true }).parsed ?? {};
  // Mode-specific sources drive the forced-mode override below (only meaningful when the mode is forced).
  const modeVars = mode ? { ...readEnvFile(`.env.${mode}`), ...readEnvFile(`.env.${mode}.local`) } : {};
  // Mirror the shared cascade's precedence: .env.<c>.local > .env.local > .env.<c> > .env (c = envCascade).
  const dotenvVars = {
    ...readEnvFile('.env'),
    ...readEnvFile(`.env.${envCascade}`),
    ...readEnvFile('.env.local'),
    ...readEnvFile(`.env.${envCascade}.local`),
  };
  // WB_ENV in process.env means the mode is explicitly forced, so values from the mode's own
  // sources (.env.<mode>[.local] and the fnox profile) win over variables inherited from the
  // parent shell — except on CI, where injected env vars must keep overriding committed files
  // (see https://github.com/WillBooster/shared/issues/930).
  const modeFileOverridesProcessEnv = !!mode && !isCI(process.env.CI);
  // fnox.toml is the committed, encrypted equivalent of .env files; local .env files still win over it.
  const [fnoxVars] = readFnoxEnvironmentVariables(cwd, fnoxCascade, dotenvVars, { modeFileOverridesProcessEnv });
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
  // Validate only AFTER applying the sources, so a WB_SKIP_ENV_CHECK defined in an env FILE is
  // honored: both the captured exported mode (it selected the cascade) and the FINAL value the
  // child will see — the env sources may define a broken WB_ENV (e.g. `.env` with
  // `WB_ENV=prodcution`), and a forced mode's files may even override a VALID exported value.
  validateStandardWbEnv(mode, 'the exported variable');
  validateStandardWbEnv(process.env.WB_ENV, 'the env source or the exported variable');
  // The selected environment is what an env source silently resolving WB_ENV to a DIFFERENT value must
  // agree with, else the child runs labeled one environment while carrying another's secrets. The
  // expectation is `fnoxCascade` only when a fnox config participates (its profile provides WB_ENV in a
  // compliant repo); in a legacy `.env`-only project FNOX_PROFILE is irrelevant, so the expectation is
  // `envCascade`. This covers both a forced `.env.production` containing `WB_ENV=development` and the
  // default-development path (`.env.development`, read even when WB_ENV is unset, containing
  // `WB_ENV=production`), comparing against the selected cascade rather than just the forced `mode`.
  // Only a STANDARD cascade is enforced (mirroring Project.completeAndValidateWbEnv): a custom suffix
  // such as `NODE_ENV=qa` legitimately selects `.env.qa` while WB_ENV stays a standard mode.
  const expectedCascade = hasProjectFnoxConfig(cwd) ? fnoxCascade : envCascade;
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
