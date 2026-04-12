import child_process from 'node:child_process';
import { constants } from 'node:os';

import { treeKill } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject, type Project } from '../project.js';
import { configureEnv, normalizeScript } from '../scripts/run.js';
import { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const FORCE_KILL_DELAY_MS = 5000;

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
  project: Project;
  killOthers: boolean;
  killOthersOnFail: boolean;
  success: 'all' | 'first';
  ci?: boolean;
  forceColor?: boolean;
}

export const concurrentlyCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof builder & typeof argumentsBuilder & typeof sharedOptionsBuilder>
> = {
  command: 'concurrently <commands...>',
  describe: 'Run commands concurrently',
  builder: { ...sharedOptionsBuilder, ...builder, ...argumentsBuilder },
  async handler(argv) {
    if (process.platform === 'win32') {
      console.error(chalk.red('This command is not supported on Windows.'));
      process.exit(1);
    }

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

    try {
      const exitCode = await runConcurrently({
        commands,
        project,
        killOthers: argv.killOthers ?? false,
        killOthersOnFail: argv.killOthersOnFail ?? false,
        success: argv.success,
        ci: typeof argv.ci === 'boolean' ? argv.ci : undefined,
        forceColor: typeof argv.forceColor === 'boolean' ? argv.forceColor : undefined,
      });
      process.exit(exitCode);
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  },
};

export async function runConcurrently(options: RunConcurrentlyOptions): Promise<number> {
  const children = options.commands.map((command) =>
    child_process.spawn(normalizeScript(command, options.project).runnable, {
      cwd: options.project.dirPath,
      detached: true,
      env: configureEnv(options.project.env, { ci: options.ci, forceColor: options.forceColor }),
      shell: true,
      stdio: 'inherit',
    })
  );

  let stopping = false;
  let interruptedSignal: NodeJS.Signals | undefined;
  let firstResult: number | undefined;
  let stopResult: number | undefined;
  const forceKillTimers: NodeJS.Timeout[] = [];
  const results = Array.from<number | undefined>({ length: children.length });
  const waitForExitPromises = children.map((child, index) => {
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = (exitCode: number): void => {
        if (settled) return;

        settled = true;
        results[index] = exitCode;
        firstResult ??= exitCode;

        if (!stopping && shouldStopOthers(exitCode, options)) {
          stopResult = exitCode;
          stopping = true;
          forceKillTimers.push(terminateChildren(children, 'SIGTERM'));
        }
        resolve();
      };

      child.once('error', (error) => {
        console.error('Failed to start child process:', error);
        settle(1);
      });
      child.once('exit', (code, signal) => {
        settle(getExitCode(code ?? undefined, signal ?? undefined));
      });
    });
  });

  const stopAll = (signal: NodeJS.Signals): void => {
    interruptedSignal ??= signal;
    if (stopping) return;

    stopping = true;
    forceKillTimers.push(terminateChildren(children, signal));
  };
  const stopOnSigint = (): void => {
    stopAll('SIGINT');
  };
  const stopOnSigterm = (): void => {
    stopAll('SIGTERM');
  };
  const stopOnSigquit = (): void => {
    stopAll('SIGQUIT');
  };
  process.on('SIGINT', stopOnSigint);
  process.on('SIGTERM', stopOnSigterm);
  process.on('SIGQUIT', stopOnSigquit);
  try {
    await Promise.all(waitForExitPromises);
  } finally {
    process.removeListener('SIGINT', stopOnSigint);
    process.removeListener('SIGTERM', stopOnSigterm);
    process.removeListener('SIGQUIT', stopOnSigquit);
    for (const timer of forceKillTimers) {
      clearTimeout(timer);
    }
  }

  if (interruptedSignal) {
    return getExitCode(undefined, interruptedSignal);
  }

  if (options.success === 'first') {
    return firstResult ?? 1;
  }
  if (stopResult !== undefined) {
    return stopResult;
  }
  for (const result of results) {
    if (result !== undefined && result !== 0) {
      return result;
    }
  }
  return 0;
}

function getExitCode(code: number | undefined, signal: NodeJS.Signals | undefined): number {
  if (code !== undefined) {
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

function terminateChildren(children: child_process.ChildProcess[], signal: NodeJS.Signals): NodeJS.Timeout {
  const forceKillPids = signalPids(toChildPids(children), signal);
  const timer = setTimeout(() => {
    signalPids(forceKillPids, 'SIGKILL');
  }, FORCE_KILL_DELAY_MS);
  timer.unref();
  return timer;
}

function toChildPids(children: child_process.ChildProcess[]): number[] {
  return children.flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
}

function signalPids(pids: readonly number[], signal: NodeJS.Signals): number[] {
  const signaledPids: number[] = [];
  for (const pid of pids) {
    try {
      if (killProcessGroup(pid, signal)) {
        signaledPids.push(pid);
      }
      treeKill(pid, signal);
    } catch (error) {
      console.warn('Failed to kill child process:', error);
    }
  }
  return signaledPids;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return false;
    }
    throw error;
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}
