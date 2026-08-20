import fs from 'node:fs';
import path from 'node:path';

import { resolveFallbackWbEnv } from '@willbooster/shared-lib-node/src';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

import { getRunScriptArgs } from '../../bin/runArgs.js';
import { findSelfProject, readAndMergeEnvironmentVariables, type Project } from '../project.js';
import { applyLocalServerUrl } from '../utils/localServerUrl.js';
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
    const project = findSelfProject(argv, true, cwd);
    const env = project?.env ?? readStandaloneEnvironment(argv, cwd);
    const command = buildRunCommand(cwd, args, env, project);
    if (argv.dryRun) {
      console.info(`Would run: ${command.join(' ')}`);
      return;
    }
    // A script run here CONSUMES the app, so the URL of a locally running server is exactly what
    // it cannot compute: an auto-selected port is a FREE one, never the port that server holds.
    // Resolved AFTER the dry-run return, which must touch nothing, and never in `wb dotenv`: that
    // is also the low-level runner wb wraps SERVER-STARTING commands in, which must keep resolving
    // their own port.
    await applyLocalServerUrl(cwd, env);
    await runCommandWithEnvironment(command, 'wb run <script> [args...]', {
      cwd,
      env,
    });
  },
};

function buildRunCommand(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv, project?: Project): string[] {
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
    const script = project ? project.packageJson.scripts?.[target] : readPackageScript(cwd, target);
    if (script !== undefined && script === env.npm_lifecycle_script) return [...args];
  }
  return ['bun', 'run', ...args];
}

function readPackageScript(cwd: string, name: string): string | undefined {
  // `bun run` resolves scripts from the nearest ancestor package.json, so match that scope
  // (e.g. --working-dir may point to a manifest-less subdirectory of the recursing package).
  for (let currentPath = path.resolve(cwd); ; currentPath = path.dirname(currentPath)) {
    const packageJsonPath = path.join(currentPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
          scripts?: Record<string, string>;
        };
        return packageJson.scripts?.[name];
      } catch {
        return undefined;
      }
    }
    if (path.dirname(currentPath) === currentPath) return undefined;
  }
}

function readStandaloneEnvironment(argv: ArgumentsCamelCase, cwd: string): NodeJS.ProcessEnv {
  const [env] = readAndMergeEnvironmentVariables(argv, cwd);
  env.WB_ENV ||= resolveFallbackWbEnv(argv);
  validateStandaloneWbEnv(argv, env);
  return env;
}

function validateStandaloneWbEnv(argv: ArgumentsCamelCase, env: NodeJS.ProcessEnv): void {
  const standardModes = new Set(['development', 'test', 'staging', 'production']);
  if (env.WB_ENV && !standardModes.has(env.WB_ENV)) {
    console.error(
      `WB_ENV must be one of development, test, staging, or production, but is "${env.WB_ENV}". ` +
        'Fix the env source or the exported variable.'
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
        'Fix the WB_ENV defined in the env sources.'
    );
    process.exit(1);
  }
}
