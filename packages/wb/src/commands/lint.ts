import path from 'node:path';

import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects } from '../project.js';
import { runWithSpawnInParallel } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { isRunningOnBun } from '../utils/runtime.js';

import { prepareForRunningCommand } from './commandUtils.js';

const builder = {
  fix: {
    description: 'Fix the linting errors',
    type: 'boolean',
  },
  format: {
    description: 'Format the code',
    type: 'boolean',
  },
} as const;

const argumentsBuilder = {
  files: {
    description: 'File and directory paths to lint',
    type: 'array',
  },
} as const;

const biomeExtensions = new Set(['cjs', 'cts', 'js', 'json', 'jsonc', 'jsx', 'mjs', 'mts', 'ts', 'tsx']);
const prettierExtensions = new Set([
  'cjs',
  'cts',
  'htm',
  'html',
  'js',
  'json',
  'jsonc',
  'jsx',
  'md',
  'mjs',
  'mts',
  'scss',
  'ts',
  'tsx',
  'vue',
  'yaml',
  'yml',
]);
const prettierOnlyExtensions = new Set([...prettierExtensions].filter((ext) => !biomeExtensions.has(ext)));

export const lintCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder & typeof argumentsBuilder>
> = {
  command: 'lint [files...]',
  describe: 'Lint the code',
  builder,
  async handler(argv) {
    if (!isRunningOnBun) {
      console.error(chalk.red('This command is only available on Bun.'));
      process.exit(1);
    }

    const projects = await findDescendantProjects(argv, false);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const files =
      argv.files
        ?.map(String)
        .filter(
          (f) =>
            f !== 'test-fixtures' &&
            !f.startsWith('test-fixtures/') &&
            !f.endsWith('/test-fixtures') &&
            !f.includes('/test-fixtures/')
        )
        .map((f) => `"${path.resolve(f)}"`) ?? [];
    const filesArg = files.join(' ');
    let biomeCommand: string;
    if (argv.fix && argv.format) {
      biomeCommand = 'check --fix';
    } else if (argv.fix) {
      biomeCommand = 'lint --fix';
    } else {
      biomeCommand = 'lint';
    }
    void runWithSpawnInParallel(
      `bun --bun biome ${biomeCommand} --no-errors-on-unmatched --files-ignore-unknown=true ${filesArg}`,
      projects.self,
      argv
    );

    const hasArgs = (argv.files ?? []).length > 0;
    if (!hasArgs && argv.format) {
      for (const project of prepareForRunningCommand('lint', projects.descendants)) {
        void runWithSpawnInParallel('bun --bun sort-package-json', project, argv);
      }
      void runWithSpawnInParallel(
        `bun --bun prettier --cache --color --write "**/{.*/,}*.{${[...prettierOnlyExtensions].join(',')}" "!**/test-fixtures/**"`,
        projects.self,
        argv
      );
    }
  },
};
