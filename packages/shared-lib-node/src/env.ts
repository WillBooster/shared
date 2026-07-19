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

export type EnvReaderOptions = Partial<ArgumentsCamelCase<InferredOptionTypes<typeof yargsOptionsBuilderForEnv>>> & {
  /**
   * Command-level fallback for an unset WB_ENV (e.g. `wb test` supplies 'test' when explicit env
   * flags suppress its default test cascade). Not a CLI flag.
   */
  commandDefaultWbEnv?: string;
};

const standardWbEnvModes = new Set(['development', 'test', 'staging', 'production']);

/**
 * Resolves the WB_ENV value wb falls back to when no env source and no exported variable defines
 * it: the forced cascade if any, then the command-level default, then the ambient-NODE_ENV-driven
 * auto cascade clamped to a standard mode (a non-standard NODE_ENV such as `qa` still selects the
 * cascade suffix, but must not produce a non-standard WB_ENV).
 */
export function resolveFallbackWbEnv(argv: EnvReaderOptions): string {
  if (argv.cascadeEnv) return argv.cascadeEnv;
  if (argv.commandDefaultWbEnv) return argv.commandDefaultWbEnv;
  // Read NODE_ENV through the alias for the same bundler-inlining reason as in
  // readEnvironmentVariables, and from the AMBIENT environment (not loaded files) because the
  // cascade selection below uses the ambient value as well.
  const runtimeEnv = process.env;
  const derived =
    argv.cascadeNodeEnv || argv.autoCascadeEnv !== false ? runtimeEnv.NODE_ENV || 'development' : 'development';
  return standardWbEnvModes.has(derived) ? derived : 'development';
}

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
  // Read NODE_ENV through an alias, never as the `process.env.NODE_ENV` member expression:
  // bundlers replace that exact expression at build time (rolldown/build-ts inline it as
  // 'production'), which constant-folds the fallback below and made the published wb select
  // the production profile whenever WB_ENV was unset.
  const runtimeEnv = process.env;
  const cascade =
    argv.cascadeEnv ??
    (argv.cascadeNodeEnv
      ? runtimeEnv.NODE_ENV || 'development'
      : argv.autoCascadeEnv
        ? runtimeEnv.WB_ENV || runtimeEnv.NODE_ENV || 'development'
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
    console.info(`WB_ENV: ${runtimeEnv.WB_ENV}, NODE_ENV: ${runtimeEnv.NODE_ENV}`);
    console.info('Reading env files:', envPaths.join(', '));
  }

  // When the caller explicitly forces a mode (--cascade-env / --cascade-node-env / an exported
  // WB_ENV), values that the mode's own env files define must win over variables inherited from
  // the parent shell: a stale `export DATABASE_URL=...` from a development shell must not leak
  // into `wb test`'s test mode (cf. https://github.com/WillBooster/shared/issues/930). On CI the
  // inherited variables keep winning — workflows deliberately inject env vars that override the
  // committed files — and that shadowing is the designed behavior, so no warning is emitted.
  const modeIsForced = Boolean(
    argv.cascadeEnv ??
    (argv.cascadeNodeEnv ? runtimeEnv.NODE_ENV || 'development' : argv.autoCascadeEnv ? runtimeEnv.WB_ENV : undefined)
  );
  const modeFileOverridesProcessEnv = modeIsForced && !isCIEnvironment(runtimeEnv.CI);
  // Override eligibility is decided per KEY, not per file: `.env.local` outranks `.env.<mode>`
  // in the cascade, so once the mode defines a key, the value winning the normal file precedence
  // (which may come from `.env.local`) must be the one overriding the shell.
  const modeSpecificEnvKeys = new Set<string>();
  if (modeFileOverridesProcessEnv && typeof cascade === 'string' && cascade.length > 0) {
    for (const envPath of envPaths) {
      if (envPath.endsWith(`.${cascade}`) || envPath.endsWith(`.${cascade}.local`)) {
        for (const key of Object.keys(readEnvFile(path.join(cwd, envPath)))) modeSpecificEnvKeys.add(key);
      }
    }
  }

  const envPathAndLoadedEnvVarNames: [string, string[]][] = [];
  const envVars: Record<string, string> = {};
  for (const envPath of envPaths) {
    const keys: string[] = [];
    for (const [key, value] of Object.entries(readEnvFile(path.join(cwd, envPath)))) {
      if (key in envVars) continue;

      const inheritedValue = process.env[key];
      const shadowedByProcessEnv = !options?.ignoreProcessEnv && key in process.env;
      if (shadowedByProcessEnv && !(modeFileOverridesProcessEnv && modeSpecificEnvKeys.has(key))) {
        continue;
      }
      if (shadowedByProcessEnv && inheritedValue !== value && !shouldSuppressOutput) {
        console.warn(
          `Warning: ${key} in ${envPath} overrides the value inherited from the parent environment because the ${cascade} environment is explicitly forced.`
        );
      }
      envVars[key] = value;
      keys.push(key);
    }
    envPathAndLoadedEnvVarNames.push([envPath, keys]);
    if (argv.verbose && !shouldSuppressOutput && keys.length > 0) {
      console.info(`Read ${keys.length} environment variables from ${envPath}`);
    }
  }
  const [fnoxEnvVars, fnoxEnvVarNames] = readFnoxEnvironmentVariables(cwd, cascade, envVars, {
    ...options,
    modeFileOverridesProcessEnv,
  });
  Object.assign(envVars, fnoxEnvVars);
  // Report the fnox source whenever fnox.toml exists — even when it yields no keys (all shadowed,
  // empty profile, or a failing export): consumers such as wb's required-environment validation
  // must see that a declared env source exists rather than silently failing open.
  if (fnoxEnvVarNames.length > 0 || hasProjectFnoxConfig(cwd)) {
    envPathAndLoadedEnvVarNames.push([fnoxEnvironmentSourceName(cascade), fnoxEnvVarNames]);
    if (argv.verbose && !shouldSuppressOutput) {
      console.info(`Read ${fnoxEnvVarNames.length} environment variables from ${fnoxEnvironmentSourceName(cascade)}`);
    }
  }
  const [miseEnvVars, miseEnvVarNames] = readMiseEnvironmentVariables(cwd, cascade, envVars, options);
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
  // Expand references against the live environment for keys NOT loaded from files, so that a
  // reference to an exported key (excluded from envVars by process-env precedence) resolves to
  // the effective value instead of an empty string. Loaded keys are deliberately absent from
  // the reference set: dotenv-expand would otherwise replace their parsed values with the
  // process values, breaking callers that need the file-defined values themselves.
  const referenceEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Escape dollar signs so dotenv-expand substitutes exported values literally instead of
    // recursively re-expanding them (an exported `pa$word` must stay `pa$word`).
    if (value !== undefined && !(key in envVars)) referenceEnv[key] = value.replaceAll('$', String.raw`\$`);
  }
  // A value referencing ${WB_ENV} must expand to what the child will actually see: when nothing
  // defines WB_ENV, wb later fills it with the fallback mode, so expose that fallback here
  // instead of expanding the reference to an empty string.
  if (!('WB_ENV' in envVars) && runtimeEnv.WB_ENV === undefined) {
    referenceEnv.WB_ENV = resolveFallbackWbEnv(argv);
  }
  // dotenv-expand resolves references in key-insertion order, so a .env value referencing a
  // fnox/mise-provided key would see an empty string if the fnox/mise entries stayed appended
  // after the .env entries. Rebuild the expansion input with the lower-priority sources first;
  // the values themselves already reflect the intended .env-over-fnox-over-mise precedence.
  const orderedEnvVars: Record<string, string> = {};
  for (const key of [...miseEnvVarNames, ...fnoxEnvVarNames]) orderedEnvVars[key] = envVars[key]!;
  Object.assign(orderedEnvVars, envVars);
  return [
    expand({ parsed: orderedEnvVars, processEnv: referenceEnv }).parsed ?? orderedEnvVars,
    envPathAndLoadedEnvVarNames,
  ];
}

/**
 * This function reads environment variables from the repository's fnox configuration (`fnox.toml`).
 * The base `[secrets]` table corresponds to `.env`, and `[profiles.<cascade>.secrets]` corresponds to
 * `.env.<cascade>`; an unknown profile falls back to the base secrets.
 */
export function readFnoxEnvironmentVariables(
  cwd: string,
  cascade: string | undefined,
  currentEnvVars: Record<string, string>,
  options?: { ignoreProcessEnv?: boolean; modeFileOverridesProcessEnv?: boolean }
): [Record<string, string>, string[]] {
  if (!hasProjectFnoxConfig(cwd)) return [{}, []];

  const secrets = runFnoxExport(cwd, cascade, { quiet: false });
  if (!secrets) return [{}, []];
  // `[profiles.<cascade>.secrets]` is the fnox analogue of `.env.<cascade>`: when the caller
  // forces a mode off CI, profile-specific values must override inherited shell variables just
  // like `.env.<mode>` values do, while base `[secrets]` values keep losing to process.env. A key
  // is profile-specific when the profile export's value differs from the base export's; when the
  // base export fails, no override is applied (conservative). The base export runs LAZILY, only
  // when a process.env collision actually needs adjudicating — it would otherwise add a
  // subprocess (including age decryption) to every forced-mode invocation for nothing.
  let cachedBaseSecrets: Record<string, unknown> | undefined | false = false;
  const getBaseSecrets = (): Record<string, unknown> | undefined => {
    if (cachedBaseSecrets === false) {
      cachedBaseSecrets = runFnoxExport(cwd, undefined, { quiet: true, ignoreProfileEnvVar: true });
    }
    return cachedBaseSecrets;
  };

  const envVars: Record<string, string> = {};
  const keys: string[] = [];
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value !== 'string' || key in currentEnvVars) continue;
    // Explicitly exported environment variables win over fnox base values, mirroring the .env rule.
    // (The mise reader below intentionally uses a value-equality check instead: `mise env` echoes
    // back variables the ambient mise activation already exported, and a differing value means the
    // requested cascade profile should win over the stale activation.)
    if (!options?.ignoreProcessEnv && key in process.env) {
      const baseSecrets = options?.modeFileOverridesProcessEnv && cascade ? getBaseSecrets() : undefined;
      const overridesProcessEnv = baseSecrets !== undefined && baseSecrets[key] !== value;
      if (!overridesProcessEnv) continue;
    }
    envVars[key] = value;
    keys.push(key);
  }
  return [envVars, keys];
}

function runFnoxExport(
  cwd: string,
  cascade: string | undefined,
  options: { quiet: boolean; ignoreProfileEnvVar?: boolean }
): Record<string, unknown> | undefined {
  // `--if-missing error`: fnox otherwise exits 0 and silently omits secrets it fails to resolve
  // (e.g. a missing age key), which would be indistinguishable from undeclared secrets.
  // `--non-interactive`: prompts or browser auth flows would hang forever because stdin is ignored.
  const args = ['export', '--format', 'json', '--no-color', '--if-missing', 'error', '--non-interactive'];
  const env = { ...process.env };
  if (cascade) {
    args.push('--profile', cascade);
  }
  if (options.ignoreProfileEnvVar) {
    // Without `--profile`, fnox falls back to FNOX_PROFILE; the base-adjudication export must
    // read the BASE secrets, so the inherited profile selection is cleared for it — and only for
    // it: a profile-less PRIMARY export (e.g. `wb dotenv` without WB_ENV) keeps honoring
    // FNOX_PROFILE.
    delete env.FNOX_PROFILE;
  }
  const result = childProcess.spawnSync('fnox', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    // The repository declares fnox-managed secrets (fnox.toml exists), so a failing export must be
    // surfaced: swallowing it would make declared secrets indistinguishable from undeclared ones.
    if (!options.quiet) {
      console.warn(
        `Failed to read fnox secrets: ${result.error?.message || result.stderr?.trim() || `fnox exited with status ${result.status}`}`
      );
    }
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return;
  }
  const secrets = (parsed as { secrets?: unknown } | undefined)?.secrets;
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) return;
  return secrets as Record<string, unknown>;
}

export function hasProjectFnoxConfig(cwd: string): boolean {
  for (let currentPath = path.resolve(cwd); ; currentPath = path.dirname(currentPath)) {
    if (fs.existsSync(path.join(currentPath, 'fnox.toml'))) {
      return true;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return false;
  }
}

function fnoxEnvironmentSourceName(cascade: string | undefined): string {
  return cascade ? `fnox export --profile ${cascade}` : 'fnox export';
}

function readMiseEnvironmentVariables(
  cwd: string,
  cascade: string | undefined,
  currentEnvVars: Record<string, string>,
  options?: { ignoreProcessEnv?: boolean }
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
    if (typeof value !== 'string' || key in currentEnvVars) continue;
    if (options?.ignoreProcessEnv) {
      // `mise env` always emits PATH due to tool shims; consumers of file-defined variables
      // (e.g. `wb gen-dev-vars`) must not propagate it.
      if (key === 'PATH') continue;
    } else if (process.env[key] === value) {
      continue;
    }
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

function isCIEnvironment(ciEnv: string | undefined): boolean {
  return !!ciEnv && ciEnv !== '0' && ciEnv !== 'false';
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
    // Existing process.env keys are kept: envVars may deliberately contain differing values that
    // must win only in the returned record (mise cascade-profile values, forced-mode overrides
    // consumed via `project.env`), never clobber the caller's own process environment.
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
