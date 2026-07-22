import fs from 'node:fs';
import path from 'node:path';

import { readEnvironmentVariables, shouldSuppressEnvironmentOutput } from '@willbooster/shared-lib-node/src';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

import { Project } from '../project.js';
import { getRunScriptArgs } from '../utils/runArgs.js';
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
    const command = usesBunRuntime(cwd) ? ['bun', 'run', ...args] : ['node', ...args];
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

function readStandaloneEnvironment(argv: ArgumentsCamelCase, cwd: string): NodeJS.ProcessEnv {
  const [envVars, envPathAndLoadedEnvVarNamePairs] = readEnvironmentVariables(argv, cwd, {
    expandFallbackWbEnv: true,
  });
  if (!shouldSuppressEnvironmentOutput(argv)) {
    for (const [envPath, names] of envPathAndLoadedEnvVarNamePairs) {
      console.info(`Loaded ${names.length} environment variables from ${envPath}`);
    }
  }
  return { ...process.env, ...envVars };
}
