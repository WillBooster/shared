import fs from 'node:fs';
import path from 'node:path';

import {
  readEnvironmentVariables,
  resolveFallbackWbEnv,
  shouldSuppressEnvironmentOutput,
} from '@willbooster/shared-lib-node/src';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

import { getRunScriptArgs } from '../../bin/runArgs.js';
import { Project } from '../project.js';
import { usesBunRuntime } from '../utils/runtime.js';
import { runCommandWithEnvironment } from './dotenv.js';

export const runCommand: CommandModule = {
  command: 'run [args..]',
  describe: 'Load environment variables and run a script with the project runtime.',
  builder: (yargs: Argv<unknown>) =>
    yargs.parserConfiguration({
      'parse-positional-numbers': false,
      'populate--': true,
      'unknown-options-as-args': true,
    }),
  async handler(argv) {
    const args = getRunScriptArgs(process.argv);
    if (args.length === 0) {
      console.error('Usage: wb run <script> [args...]');
      process.exit(1);
    }
    const cwd = process.cwd();
    const env = fs.existsSync(path.join(cwd, 'package.json'))
      ? new Project(cwd, argv, true).env
      : readStandaloneEnvironment(argv, cwd);
    const command = buildRunCommand(cwd, args);
    if (argv.dryRun) {
      console.info(`Would run: ${command.join(' ')}`);
      return;
    }
    await runCommandWithEnvironment(command, 'wb run <script> [args...]', {
      cwd,
      env,
    });
  },
};

function buildRunCommand(cwd: string, args: readonly string[]): string[] {
  if (!usesBunRuntime(cwd)) return ['node', ...args];
  // `bun run` resolves package.json scripts before local binaries, so a script that invokes
  // `wb run <its own name>` (e.g. "vitest": "wb run vitest run") would respawn itself forever.
  // When invoked from the same-named lifecycle script, bypass script resolution and execute the
  // binary directly; runCommandWithEnvironment prepends node_modules/.bin to PATH.
  if (args[0] === process.env.npm_lifecycle_event) return [...args];
  return ['bun', 'run', ...args];
}

function readStandaloneEnvironment(argv: ArgumentsCamelCase, cwd: string): NodeJS.ProcessEnv {
  const [envVars, envPathAndLoadedEnvVarNamePairs] = readEnvironmentVariables(argv, cwd, {
    expandFallbackWbEnv: true,
  });
  if (!shouldSuppressEnvironmentOutput(argv)) {
    for (const [envPath, names] of envPathAndLoadedEnvVarNamePairs) {
      console.info(`Loaded ${names.length} environment variables from ${envPath}`);
    }
  }
  const env = { ...process.env, ...envVars };
  env.WB_ENV ||= resolveFallbackWbEnv(argv);
  validateStandaloneWbEnv(argv, env);
  return env;
}

function validateStandaloneWbEnv(argv: ArgumentsCamelCase, env: NodeJS.ProcessEnv): void {
  if (env.WB_SKIP_ENV_CHECK === '1' || env.WB_SKIP_ENV_CHECK === 'true') return;
  const standardModes = new Set(['development', 'test', 'staging', 'production']);
  if (env.WB_ENV && !standardModes.has(env.WB_ENV)) {
    console.error(
      `WB_ENV must be one of development, test, staging, or production, but is "${env.WB_ENV}". ` +
        'Fix the env source or the exported variable, or set WB_SKIP_ENV_CHECK=1 to skip this check.'
    );
    process.exit(1);
  }

  const runtimeEnv = process.env;
  const selectedCascade =
    typeof argv.cascadeEnv === 'string'
      ? argv.cascadeEnv
      : argv.cascadeNodeEnv
        ? runtimeEnv.NODE_ENV || 'development'
        : argv.autoCascadeEnv !== false
          ? runtimeEnv.WB_ENV || runtimeEnv.NODE_ENV || 'development'
          : undefined;
  if (env.WB_ENV && selectedCascade && standardModes.has(selectedCascade) && env.WB_ENV !== selectedCascade) {
    console.error(
      `WB_ENV resolves to "${env.WB_ENV}" although the "${selectedCascade}" environment was selected. ` +
        'Fix the WB_ENV defined in the env sources, or set WB_SKIP_ENV_CHECK=1 to skip this check.'
    );
    process.exit(1);
  }
}
