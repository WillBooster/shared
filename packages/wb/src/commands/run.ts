import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

import { Project } from '../project.js';
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
    const project = new Project(process.cwd(), argv, false);
    const command = project.usesBunPackageManager ? ['bun', 'run', ...args] : ['node', ...args];
    await runCommandWithEnvironment(command, 'wb run <script> [args...]');
  },
};

function getParsedRunArgs(argv: ArgumentsCamelCase): ParsedRunArgs {
  return {
    args: [
      ...((argv.args as unknown[] | undefined) ?? []).map(String),
      ...((argv['--'] as unknown[] | undefined) ?? []).map(String),
    ],
  };
}
