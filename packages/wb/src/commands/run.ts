import fs from 'node:fs';
import path from 'node:path';

import { readEnvironmentVariables, shouldSuppressEnvironmentOutput } from '@willbooster/shared-lib-node/src';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

import { Project } from '../project.js';
import { usesBunRuntime } from '../utils/runtime.js';
import { runCommandWithEnvironment } from './dotenv.js';

interface ParsedRunArgs {
  args: string[];
}

export const runCommand: CommandModule = {
  command: 'run [args..]',
  describe: 'Load environment variables and run a script with the project runtime.',
  builder: (yargs: Argv<unknown>) => yargs.parserConfiguration({ 'populate--': true, 'unknown-options-as-args': true }),
  async handler(argv) {
    const { args } = getParsedRunArgs(argv);
    if (args.length === 0) {
      console.error('Usage: wb run <script> [args...]');
      process.exit(1);
    }
    const cwd = process.cwd();
    const env = fs.existsSync(path.join(cwd, 'package.json'))
      ? new Project(cwd, argv, true).env
      : readStandaloneEnvironment(argv, cwd);
    const command = usesBunRuntime(cwd) ? ['bun', 'run', ...args] : ['node', ...args];
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

function getParsedRunArgs(argv: ArgumentsCamelCase): ParsedRunArgs {
  return {
    args: [
      ...((argv.args as unknown[] | undefined) ?? []).map(String),
      ...((argv['--'] as unknown[] | undefined) ?? []).map(String),
    ],
  };
}
