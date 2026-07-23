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
    const command = buildRunCommand(cwd, args, env);
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

function buildRunCommand(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string[] {
  if (!usesBunRuntime(cwd)) return ['node', ...args];
  // `bun run` resolves package.json scripts before local binaries, so a script that invokes
  // `wb run <its own name>` (e.g. "vitest": "wb run vitest run") would respawn itself forever.
  // Bypass script resolution only for genuine self-recursion: the target names the lifecycle
  // script that spawned this process AND the current package declares that very script text —
  // a cross-package delegation via --working-dir reaches a different script text, so it still
  // runs the destination's script. runCommandWithEnvironment prepends node_modules/.bin to
  // PATH, resolving the direct execution to the local binary.
  const target = args[0];
  if (target && target === env.npm_lifecycle_event) {
    const script = readPackageScript(cwd, target);
    if (script !== undefined && script === env.npm_lifecycle_script) return [...args];
  }
  return ['bun', 'run', ...args];
}

function readPackageScript(cwd: string, name: string): string | undefined {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return packageJson.scripts?.[name];
  } catch {
    return undefined;
  }
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
