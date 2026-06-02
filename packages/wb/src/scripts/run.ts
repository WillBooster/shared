import { spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { ArgumentsCamelCase, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { promisePool } from '../utils/promisePool.js';

interface Options {
  ci?: boolean;
  exitIfFailed?: boolean;
  onSignal?: (signal: NodeJS.Signals | null) => void;
  omitSilentStart?: boolean;
  preserveColor?: boolean;
  processSilentOutput?: (output: string) => string;
  printRawOutput?: boolean;
  printSilentOutputOnFailureOnly?: boolean;
  silentProgressIntervalMs?: number;
  silentSuccessMessage?: string;
  timeout?: number;
}

const defaultOptions: Options = {
  exitIfFailed: true,
};

export interface BufferedRunResult {
  exitCode: number;
  output: string;
}

export async function runWithSpawn(
  script: string,
  project: Project,
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof sharedOptionsBuilder>>> & { silent?: boolean },
  opts: Options = defaultOptions
): Promise<number> {
  const normalizedScript = normalizeScript(script, project);
  if (!(argv.silent && opts.omitSilentStart && !argv.dryRun)) {
    printStart(normalizedScript.printable, project, argv.silent ? 'Command' : 'Start');
  }
  if (argv.verbose) {
    printStart(normalizedScript.runnable, project, 'Start (raw)', true);
  }
  if (argv.dryRun) {
    printFinishedAndExitIfNeeded(normalizedScript.printable, 0, opts, { silentSuccess: argv.silent });
    return 0;
  }

  const shouldProcessSilentOutput = Boolean(
    argv.silent && (opts.processSilentOutput ?? opts.printSilentOutputOnFailureOnly)
  );
  let wroteSilentProgress = false;
  const progressTimer =
    argv.silent && opts.silentProgressIntervalMs
      ? setInterval(() => {
          process.stdout.write('.');
          wroteSilentProgress = true;
        }, opts.silentProgressIntervalMs)
      : undefined;
  const ret = await spawnAsync(normalizedScript.runnable, undefined, {
    cwd: project.dirPath,
    env: configureEnv(project.env, { ...opts, preserveColor: opts.preserveColor ?? (argv.silent ? true : undefined) }),
    shell: true,
    stdio: argv.silent ? 'pipe' : 'inherit',
    timeout: opts.timeout,
    mergeOutAndError: shouldProcessSilentOutput,
    killOnExit: true,
    printingStdout: argv.silent && !shouldProcessSilentOutput,
    printingStderr: argv.silent && !shouldProcessSilentOutput,
    omitBlankLinesWhilePrinting: argv.silent,
    verbose: argv.verbose,
  }).finally(() => {
    if (progressTimer) {
      clearInterval(progressTimer);
    }
  });
  const exitCode = ret.status ?? 1;
  if (wroteSilentProgress) {
    process.stdout.write('\n');
  }
  if (shouldProcessSilentOutput && (!opts.printSilentOutputOnFailureOnly || exitCode !== 0)) {
    const output = (opts.processSilentOutput ? opts.processSilentOutput(ret.stdout) : ret.stdout).trim();
    if (output) {
      process.stdout.write(output);
      process.stdout.write('\n');
    }
  }
  if (argv.silent && exitCode === 0 && opts.silentSuccessMessage) {
    console.info(chalk.green(opts.silentSuccessMessage));
  }
  opts.onSignal?.(ret.signal);
  printFinishedAndExitIfNeeded(normalizedScript.printable, exitCode, opts, { silentSuccess: argv.silent });
  return exitCode;
}

export function runWithSpawnInParallel(
  script: string,
  project: Project,
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof sharedOptionsBuilder>>>,
  opts: Options = defaultOptions
): Promise<number> {
  return promisePool.runAndWaitForReturnValue(async () => {
    const normalizedScript = normalizeScript(script, project);
    printStart(normalizedScript.printable, project, 'Start (parallel)', true);
    if (argv.dryRun) {
      printStart(normalizedScript.printable, project, 'Started (log)');
      if (argv.verbose) {
        printStart(normalizedScript.runnable, project, 'Started (raw)', true);
      }
      printFinishedAndExitIfNeeded(normalizedScript.printable, 0, opts);
      return 0;
    }

    const ret = await spawnAsync(normalizedScript.runnable, undefined, {
      cwd: project.dirPath,
      env: configureEnv(project.env, { ...opts, preserveColor: opts.preserveColor ?? true }),
      shell: true,
      stdio: 'pipe',
      timeout: opts.timeout,
      mergeOutAndError: true,
      killOnExit: true,
      printingStdout: opts.printRawOutput,
      printingStderr: opts.printRawOutput,
      verbose: argv.verbose,
    });
    opts.onSignal?.(ret.signal);
    printStart(normalizedScript.printable, project, 'Started (log)');
    if (argv.verbose) {
      printStart(normalizedScript.runnable, project, 'Started (raw)', true);
    }
    const out = ret.stdout.trim();
    if (out && !opts.printRawOutput) {
      process.stdout.write(out);
      process.stdout.write('\n');
    }
    printFinishedAndExitIfNeeded(normalizedScript.printable, ret.status, opts);
    return ret.status ?? 1;
  });
}

export function runWithSpawnInParallelBuffered(
  script: string,
  project: Project,
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof sharedOptionsBuilder>>>,
  opts: Options = defaultOptions
): Promise<BufferedRunResult> {
  return promisePool.runAndWaitForReturnValue(async () => {
    const normalizedScript = normalizeScript(script, project);
    if (argv.dryRun) {
      return {
        exitCode: 0,
        output: '',
      };
    }

    const ret = await spawnAsync(normalizedScript.runnable, undefined, {
      cwd: project.dirPath,
      env: configureEnv(project.env, { ...opts, preserveColor: opts.preserveColor ?? true }),
      shell: true,
      stdio: 'pipe',
      timeout: opts.timeout,
      mergeOutAndError: true,
      killOnExit: true,
      printingStdout: opts.printRawOutput,
      printingStderr: opts.printRawOutput,
      verbose: argv.verbose,
    });
    opts.onSignal?.(ret.signal);
    return {
      exitCode: ret.status ?? 1,
      output: ret.stdout,
    };
  });
}

/**
 * Replace capitalized commands (e.g., YARN, PRISMA, BUN) with suitable commands.
 */
export function normalizeScript(script: string, project: Project): { printable: string; runnable: string } {
  const projectPackageManagerWithRun = project.usesBunPackageManager ? 'bun --bun run' : 'yarn';
  let newScript = script
    .replaceAll('\n', '')
    .replaceAll(/\s\s+/g, ' ')
    .replaceAll(
      /PRISMA generate(?!\s+--no-hints)(?=\s|$)/gu,
      project.packageJson.dependencies?.blitz ? 'PRISMA generate' : 'PRISMA generate --no-hints'
    )
    .replaceAll('PRISMA ', project.packageJson.dependencies?.blitz ? 'YARN blitz prisma ' : 'YARN prisma ')
    .replaceAll('BUN run ', project.usesBunPackageManager ? `${projectPackageManagerWithRun} ` : 'YARN run ')
    .replaceAll('BUN ', project.usesBunPackageManager ? `${projectPackageManagerWithRun} ` : 'YARN ')
    // Avoid replacing `YARN run` with `run` by replacing `YARN` with `(yarn|bun --bun) run`.
    .replaceAll('YARN run ', project.usesBunPackageManager ? `${projectPackageManagerWithRun} ` : 'yarn run ');
  if (project.usesBunPackageManager) {
    newScript = newScript
      .replaceAll('YARN build-ts run', 'bun --bun run')
      .replaceAll('bun --bun run bun --bun run', 'bun --bun run')
      // Because bun can run src/index.ts directly.
      .replaceAll('dist/index.js', 'src/index.ts');
  }
  newScript = newScript.trim();
  const printableScript = fixBunCommand(newScript.replaceAll('YARN ', `${projectPackageManagerWithRun} `));
  const runnableScript = fixBunCommand(
    newScript
      // Keep Playwright as a package-manager command instead of resolving it through node_modules/.bin.
      .replaceAll('YARN playwright ', `${projectPackageManagerWithRun} playwright `)
      .replaceAll(
        'YARN ',
        !project.usesBunPackageManager && project.binExists ? '' : `${projectPackageManagerWithRun} `
      )
  );
  return {
    printable: `${projectPackageManagerWithRun} dotenv -- ${printableScript}`,
    runnable: runnableScript,
  };
}

export function printStart(normalizedScript: string, project: Project, prefix = 'Start', weak = false): void {
  console.info(
    '\n' +
      (weak ? chalk.gray : chalk.cyan)(chalk.bold(`${prefix}:`), normalizedScript) +
      chalk.gray(` at ${project.dirPath}`)
  );
}

export function printFinishedAndExitIfNeeded(
  script: string,
  exitCode: number | null,
  opts: Omit<Options, 'timeout'>,
  printOptions: { silentSuccess?: boolean } = {}
): void {
  if (exitCode === 0) {
    if (printOptions.silentSuccess) return;
    console.info(chalk.green(chalk.bold('Finished:'), script));
  } else {
    console.info(chalk.red(chalk.bold(`Failed (exit code ${exitCode}): `), script));
    if (opts.exitIfFailed !== false) {
      process.exit(exitCode ?? 1);
    }
  }
}

export function configureEnv(
  env: Record<string, string | undefined>,
  opts: Options
): Record<string, string | undefined> {
  const newEnv = { ...env };
  if (opts.ci) {
    newEnv.CI = '1';
  }
  configureColorEnv(newEnv, opts.preserveColor);
  return newEnv;
}

/**
 * Configures child-process color environment variables for wb-managed output.
 *
 * @param env The child-process environment to mutate.
 * @param preserveColor Whether wb should preserve colors for output that it captures and reprints to an interactive TTY.
 */
export function configureColorEnv(env: Record<string, string | undefined>, preserveColor?: boolean): void {
  if (env.NO_COLOR !== undefined || preserveColor === false) {
    // NO_COLOR and preserveColor=false are explicit no-color choices, so inherited FORCE_COLOR must not leak through.
    delete env.FORCE_COLOR;
  } else if (preserveColor && process.stdout.isTTY) {
    env.FORCE_COLOR ||= '3';
  }
}

function fixBunCommand(command: string): string {
  // cf. https://github.com/oven-sh/bun/issues/14359
  return command.includes('next dev') ||
    // cf. https://github.com/oven-sh/bun/issues/8222
    command.includes('playwright') ||
    // "bun --bun prisma generate" doesn't work
    command.includes('prisma') ||
    command.includes('test/e2e-additional')
    ? command.replaceAll('bun --bun', 'bun')
    : command;
}
