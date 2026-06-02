import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  readAndApplyEnvironmentVariables,
  removeNpmAndYarnEnvironmentVariables,
} from '@willbooster/shared-lib-node/src';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

interface DotenvOptions {
  cascadeEnv?: string;
  checkEnv?: string;
  env?: string[];
  includeRootEnv?: boolean;
  quietEnv?: boolean;
  verbose?: boolean;
  workingDir?: string;
}

interface ParsedDotenvArgs {
  command: string[];
  options: DotenvOptions;
}

export const dotenvCommand: CommandModule = {
  command: 'dotenv [args..]',
  describe: 'Load .env files and run a command.',
  builder: (yargs: Argv<unknown>) =>
    yargs
      .parserConfiguration({ 'populate--': true })
      .option('cascade-env', {
        alias: 'c',
        description: 'Environment to load cascading .env files.',
        type: 'string',
      })
      .option('env', {
        alias: 'e',
        description: '.env files to be loaded.',
        type: 'array',
      })
      .option('check-env', {
        description: 'Check whether loaded env keys match the given .env file.',
        type: 'string',
      })
      .option('quiet-env', {
        description: 'Suppress .env file loading information.',
        type: 'boolean',
      }),
  async handler(argv) {
    await runParsedDotenvCommand(getParsedDotenvArgsFromYargs(argv));
  },
};

export async function runDotenvCommand(args: string[]): Promise<void> {
  await runParsedDotenvCommand(parseDotenvArgs(args));
}

async function runParsedDotenvCommand({ command, options }: ParsedDotenvArgs): Promise<void> {
  if (command.length === 0) {
    console.error('Usage: wb dotenv [-c <environment>] [--env <file>] -- <command> [args...]');
    process.exit(1);
  }

  const cwd = path.resolve(options.workingDir ?? process.cwd());
  if (options.workingDir) {
    process.chdir(cwd);
  }
  if (options.cascadeEnv) {
    process.env.WB_ENV ||= options.cascadeEnv;
  }
  readAndApplyEnvironmentVariables(
    {
      autoCascadeEnv: false,
      cascadeEnv: options.cascadeEnv,
      checkEnv: options.checkEnv,
      env: options.env,
      includeRootEnv: options.includeRootEnv ?? true,
      quietEnv: options.quietEnv ?? true,
      verbose: options.verbose,
    },
    cwd
  );
  removeNpmAndYarnEnvironmentVariables(process.env);

  const child = spawn(command[0]!, command.slice(1), {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  child.on('error', (error) => {
    console.error(error);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

function getParsedDotenvArgsFromYargs(argv: ArgumentsCamelCase): ParsedDotenvArgs {
  const command = [
    ...((argv.args as unknown[] | undefined) ?? []).map(String),
    ...((argv['--'] as unknown[] | undefined) ?? []).map(String),
  ];
  return normalizeParsedDotenvArgs({
    command,
    options: {
      cascadeEnv: typeof argv.cascadeEnv === 'string' ? argv.cascadeEnv : undefined,
      checkEnv: process.argv.some((arg) => arg === '--check-env' || arg.startsWith('--check-env='))
        ? String(argv.checkEnv)
        : undefined,
      env: Array.isArray(argv.env) ? argv.env.map(String) : undefined,
      includeRootEnv: typeof argv.includeRootEnv === 'boolean' ? argv.includeRootEnv : undefined,
      quietEnv: typeof argv.quietEnv === 'boolean' ? argv.quietEnv : undefined,
      verbose: typeof argv.verbose === 'boolean' ? argv.verbose : undefined,
      workingDir: typeof argv.workingDir === 'string' ? argv.workingDir : undefined,
    },
  });
}

function parseDotenvArgs(args: string[]): ParsedDotenvArgs {
  const options: DotenvOptions = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      return normalizeParsedDotenvArgs({ command: args.slice(index + 1), options });
    }
    if (!arg.startsWith('-')) {
      return normalizeParsedDotenvArgs({ command: args.slice(index), options });
    }

    const nextValue = (): string => {
      const value = args[++index];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      return value;
    };
    if (arg === '-c' || arg === '--cascade-env') {
      options.cascadeEnv = nextValue();
    } else if (arg.startsWith('-c=')) {
      options.cascadeEnv = arg.slice('-c='.length);
    } else if (arg.startsWith('--cascade-env=')) {
      options.cascadeEnv = arg.slice('--cascade-env='.length);
    } else if (arg === '-e' || arg === '--env') {
      options.env = [...(options.env ?? []), nextValue()];
    } else if (arg.startsWith('--env=')) {
      options.env = [...(options.env ?? []), arg.slice('--env='.length)];
    } else if (arg === '--check-env') {
      options.checkEnv = nextValue();
    } else if (arg.startsWith('--check-env=')) {
      options.checkEnv = arg.slice('--check-env='.length);
    } else if (arg === '--include-root-env') {
      options.includeRootEnv = true;
    } else if (arg === '--include-root-env=false' || arg === '--no-include-root-env') {
      options.includeRootEnv = false;
    } else if (arg === '--quiet' || arg === '--quiet-env') {
      options.quietEnv = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--working-dir') {
      options.workingDir = nextValue();
    } else if (arg.startsWith('--working-dir=')) {
      options.workingDir = arg.slice('--working-dir='.length);
    } else {
      throw new Error(`Unknown wb dotenv option: ${arg}`);
    }
  }
  return normalizeParsedDotenvArgs({ command: [], options });
}

function normalizeParsedDotenvArgs(parsed: ParsedDotenvArgs): ParsedDotenvArgs {
  if (!parsed.options.cascadeEnv && !parsed.options.env) {
    parsed.options.env = ['.env'];
  }
  return parsed;
}
