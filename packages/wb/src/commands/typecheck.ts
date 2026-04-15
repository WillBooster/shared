import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects } from '../project.js';
import type { Project } from '../project.js';
import { runWithSpawnInParallel } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const builder = {} as const;

type TypeCheckCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
export type TypeCheckCommandArgv = ArgumentsCamelCase<TypeCheckCommandOptions>;

export const typeCheckCommand: CommandModule<unknown, TypeCheckCommandOptions> = {
  command: 'typecheck',
  describe: 'Run type checking. .env files are ignored.',
  builder,
  async handler(argv) {
    process.exit(await typeCheck(argv));
  },
};

export async function typeCheck(argv: TypeCheckCommandArgv): Promise<number> {
  const projects = await findDescendantProjects(argv, false);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    return 1;
  }

  let removedNextDir = false as boolean;
  const promises = projects.descendants.map(async (project) => {
    const commands: string[] = [];
    if (!project.packageJson.workspaces || project.hasSourceCode) {
      commands.push(...buildTypeScriptTypeCheckCommands(project));
    }
    if (!project.packageJson.workspaces && project.hasOwnDependency('pyright')) {
      commands.push('YARN pyright');
    }
    while (commands.length > 0) {
      const exitCode = await runWithSpawnInParallel(commands.join(' && '), project, argv, {
        // Disable interactive mode
        ci: projects.descendants.length > 1,
        exitIfFailed: false,
        forceColor: true,
      });

      // Re-try type checking after removing `.next` directory
      const nextDirPath = path.join(project.dirPath, '.next');
      if (exitCode && fs.existsSync(nextDirPath)) {
        fs.rmSync(nextDirPath, { force: true, recursive: true });
        console.info(chalk.yellow('Removed `.next` directory. We will re-try type checking.'));
        removedNextDir = true;
        continue;
      }

      return exitCode;
    }
  });
  const exitCodes = await Promise.all(promises);
  let finalExitCode = 0;
  for (const [i, exitCode] of exitCodes.entries()) {
    if (exitCode) {
      const deps = projects.descendants[i]?.packageJson.dependencies ?? {};
      if (deps.blitz) {
        console.info(chalk.yellow('Please try "yarn gen-code" if you face unknown type errors.'));
      }
      finalExitCode = exitCode;
    }
  }
  if (!finalExitCode)
    console.info(
      chalk.green(
        removedNextDir
          ? '-----\nNo type errors found. Please ignore the previous type errors, as they were caused by outdated Next.js cache files.'
          : 'No type errors found.'
      )
    );
  return finalExitCode;
}

function buildTypeScriptTypeCheckCommands(project: Project): string[] {
  if (project.hasOwnDependency('@typescript/native-preview')) {
    return ['BUN tsgo --noEmit'];
  }
  if (project.hasOwnDependency('typescript')) {
    return ['BUN tsc --noEmit'];
  }
  return [];
}

export const tcCommand: CommandModule<unknown, TypeCheckCommandOptions> = {
  ...typeCheckCommand,
  command: 'tc',
};
