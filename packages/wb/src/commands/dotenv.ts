import { spawn } from 'node:child_process';
import path from 'node:path';

import { removeNpmAndYarnEnvironmentVariables } from '@willbooster/shared-lib-node/src';

import { prependNodeModulesBinToPath } from '../utils/binPath.js';
import { config } from 'dotenv';
import { expand } from 'dotenv-expand';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

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

export async function runDotenvCommand(args: string[]): Promise<void> {
  await runParsedDotenvCommand(parseDotenvArgs(args));
}

async function runParsedDotenvCommand({ command }: ParsedDotenvArgs): Promise<void> {
  if (command.length === 0) {
    console.error('Usage: wb dotenv -- <command> [args...]');
    process.exit(1);
  }

  const cwd = path.resolve(process.cwd());
  readAndApplyEnvironmentVariables(cwd);
  removeNpmAndYarnEnvironmentVariables(process.env);
  // Stripping yarn's environment also removes its temporary bin folder — the ONLY place
  // yarn Berry exposes dependency executables — so restore the project's own
  // node_modules/.bin directories to keep bare binary names resolvable.
  prependNodeModulesBinToPath(cwd, process.env);

  const child = spawn(command[0]!, command.slice(1), {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  let forwardedShutdownSignal: NodeJS.Signals | undefined;
  child.on('error', (error) => {
    console.error(error);
    process.exit(1);
  });
  for (const signal of shutdownSignals) {
    const signalHandler = (): void => {
      forwardedShutdownSignal = signal;
      child.kill(signal);
    };
    signalHandlers.set(signal, signalHandler);
    process.once(signal, signalHandler);
  }
  child.on('exit', (code, signal) => {
    for (const [shutdownSignal, signalHandler] of signalHandlers) {
      process.off(shutdownSignal, signalHandler);
    }
    if (signal && signal === forwardedShutdownSignal) {
      process.exit(0);
    }
    if (signal) {
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

function parseDotenvArgs(args: string[]): ParsedDotenvArgs {
  const separatorIndex = args.indexOf('--');
  return { command: separatorIndex === -1 ? args : args.slice(separatorIndex + 1) };
}

function readAndApplyEnvironmentVariables(cwd: string): void {
  const parsed = {
    ...config({ path: path.join(cwd, '.env'), processEnv: {}, quiet: true }).parsed,
    ...(process.env.WB_ENV
      ? (config({ path: path.join(cwd, `.env.${process.env.WB_ENV}`), processEnv: {}, quiet: true }).parsed ?? {})
      : {}),
  };
  const envVars = expand({ parsed, processEnv: {} }).parsed ?? parsed;
  for (const [key, value] of Object.entries(envVars)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
