import child_process from 'node:child_process';
import { constants } from 'node:os';

import { treeKill } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const builder = {
  'kill-others': {
    description: 'Kill other commands when one command exits',
    type: 'boolean',
  },
  'kill-others-on-fail': {
    description: 'Kill other commands when one command fails',
    type: 'boolean',
  },
  success: {
    description: 'Define successful completion criteria',
    type: 'string',
    choices: ['all', 'first'],
    default: 'all',
  },
} as const;

const argumentsBuilder = {
  commands: {
    description: 'Commands to run concurrently',
    type: 'array',
  },
} as const;

interface RunConcurrentlyOptions {
  commands: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  killOthers: boolean;
  killOthersOnFail: boolean;
  success: 'all' | 'first';
}

export const concurrentlyCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof builder & typeof argumentsBuilder & typeof sharedOptionsBuilder>
> = {
  command: 'concurrently <commands...>',
  describe: 'Run commands concurrently',
  builder: { ...builder, ...argumentsBuilder },
  async handler(argv) {
    const project = findSelfProject(argv);
    if (!project) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const commands = (argv.commands ?? []).map(String).filter(Boolean);
    if (commands.length === 0) {
      console.error(chalk.red('No commands provided.'));
      process.exit(1);
    }

    const exitCode = await runConcurrently({
      commands,
      cwd: project.dirPath,
      env: project.env,
      killOthers: argv.killOthers ?? false,
      killOthersOnFail: argv.killOthersOnFail ?? false,
      success: argv.success,
    });
    process.exit(exitCode);
  },
};

export async function runConcurrently(options: RunConcurrentlyOptions): Promise<number> {
  const children = options.commands.map((command) =>
    child_process.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: 'inherit',
    })
  );

  let stopping = false;
  let firstResult: number | undefined;
  const results = Array.from<number | undefined>({ length: children.length });
  const waitForExitPromises = children.map((child, index) => {
    return new Promise<void>((resolve) => {
      child.on('exit', (code, signal) => {
        const exitCode = getExitCode(code, signal);
        results[index] = exitCode;
        firstResult ??= exitCode;

        if (!stopping && shouldStopOthers(exitCode, options)) {
          stopping = true;
          terminateChildren(children, child.pid);
        }
        resolve();
      });
    });
  });

  const stopAll = (): void => {
    if (stopping) return;

    stopping = true;
    terminateChildren(children);
  };
  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);
  process.on('SIGQUIT', stopAll);
  try {
    await Promise.all(waitForExitPromises);
  } finally {
    process.removeListener('SIGINT', stopAll);
    process.removeListener('SIGTERM', stopAll);
    process.removeListener('SIGQUIT', stopAll);
  }

  if (options.success === 'first') {
    return firstResult ?? 1;
  }
  for (const result of results) {
    if (result !== undefined && result !== 0) {
      return result;
    }
  }
  return 0;
}

function getExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) {
    return code;
  }
  if (signal && signal in constants.signals) {
    return 128 + constants.signals[signal];
  }
  return 1;
}

function shouldStopOthers(
  exitCode: number,
  options: Pick<RunConcurrentlyOptions, 'killOthers' | 'killOthersOnFail' | 'success'>
): boolean {
  return options.success === 'first' || options.killOthers || (options.killOthersOnFail && exitCode !== 0);
}

function terminateChildren(children: child_process.ChildProcess[], exceptPid?: number): void {
  for (const child of children) {
    if (!child.pid || child.pid === exceptPid) continue;

    try {
      treeKill(child.pid);
    } catch (error) {
      console.warn(`Failed to kill process ${child.pid}:`, error);
    }
  }
}
