import fs from 'node:fs/promises';

import chalk from 'chalk';
import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findAllProjects } from '../project.js';
import { runWithSpawn } from '../scripts/run.js';
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
    const projects = await findAllProjects(argv, false);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    for (const project of projects.all) {
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
      if (commands.length === 0) continue;

      console.info(`Running "typecheck" for ${project.name} ...`);

      if (projects.all.length > 1) {
        // Disable interactive mode
        project.env['CI'] = '1';
      }
      project.env['FORCE_COLOR'] ||= '3';

      const exitCode = await runWithSpawn(commands.join(' && '), project, argv);
      if (exitCode !== 0) {
        const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
        const deps = packageJson.dependencies || {};
        if (deps['blitz']) {
          console.info(chalk.yellow('Please try "yarn gen-code" if you face unknown type errors.'));
        }
      }
    }
  },
};

export const tcCommand: CommandModule<unknown, InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>> = {
  ...typeCheckCommand,
  command: 'tc',
};
