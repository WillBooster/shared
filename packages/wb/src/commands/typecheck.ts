import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects } from '../project.js';
import { runWithSpawnInParallel } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const builder = {} as const;

export const typeCheckCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>
> = {
  command: 'typecheck',
  describe: 'Run type checking. .env files are ignored.',
  builder,
  async handler(argv) {
    const projects = await findDescendantProjects(argv, false);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const promises = projects.descendants.map(async (project) => {
      const commands: string[] = [];
      if (!project.packageJson.workspaces) {
        if (project.packageJson.dependencies?.typescript || project.packageJson.devDependencies?.typescript) {
          commands.push('BUN tsc --noEmit --Pretty');
        }
        if (project.packageJson.devDependencies?.pyright) {
          commands.push('YARN pyright');
        }
      } else if (
        project.hasSourceCode &&
        (project.packageJson.dependencies?.typescript || project.packageJson.devDependencies?.typescript)
      ) {
        commands.push('BUN tsc --noEmit --Pretty');
      }
      while (commands.length > 0) {
        const exitCode = await runWithSpawnInParallel(commands.join(' && '), project, argv, {
          // Disable interactive mode
          ci: projects.descendants.length > 1,
          forceColor: true,
        });

        // Re-try type checking after removing `.next` directory
        const nextDirPath = path.join(project.dirPath, '.next');
        if (exitCode && fs.existsSync(nextDirPath)) {
          fs.rmSync(nextDirPath, { force: true, recursive: true });
          continue;
        }

        return exitCode;
      }
    });
    const exitCodes = await Promise.all(promises);
    let finalExitCode = 0;
    for (const [i, exitCode] of exitCodes.entries()) {
      if (exitCode) {
        const deps = projects.descendants[i].packageJson.dependencies || {};
        if (deps['blitz']) {
          console.info(chalk.yellow('Please try "yarn gen-code" if you face unknown type errors.'));
        }
        finalExitCode = exitCode;
      }
    }
    if (finalExitCode) process.exit(finalExitCode);
  },
};

export const tcCommand: CommandModule<unknown, InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>> = {
  ...typeCheckCommand,
  command: 'tc',
};
