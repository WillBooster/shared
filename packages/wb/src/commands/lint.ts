import path from 'node:path';

import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects } from '../project.js';
import { runWithSpawnInParallel } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { isRunningOnBun } from '../utils/runtime.js';

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
  describe: 'Lint code on Bun',
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

    const files = argv.files ?? [];
    let biomeArgsText: string;
    let prettierArgsText: string;
    let sortPackageJsonArgsText: string;
    if (files.length > 0) {
      const filePathsToBeCheckedByBiome: string[] = [];
      const filePathsToBeFormattedByPrettier: string[] = [];
      const packageJsonFilePaths: string[] = [];
      for (const file of files) {
        const filePath = path.resolve(String(file));
        if (filePath.endsWith('/test-fixtures') || filePath.includes('/test-fixtures/')) {
          continue;
        }

        const extension = path.extname(filePath).slice(1);
        if (filePath.endsWith('/package.json')) {
          packageJsonFilePaths.push(filePath);
        } else if (biomeExtensions.has(extension)) {
          filePathsToBeCheckedByBiome.push(filePath);
        } else if (prettierExtensions.has(extension)) {
          filePathsToBeFormattedByPrettier.push(filePath);
        }
      }
      biomeArgsText = filePathsToBeCheckedByBiome.map((f) => `"${f}"`).join(' ');
      prettierArgsText = filePathsToBeFormattedByPrettier.map((f) => `"${f}"`).join(' ');
      sortPackageJsonArgsText = packageJsonFilePaths.map((f) => `"${f}"`).join(' ');
    } else {
      biomeArgsText = '';
      prettierArgsText = `"**/{.*/,}*.{${[...prettierOnlyExtensions].join(',')}" "!**/test-fixtures/**"`;
      sortPackageJsonArgsText = projects.descendants.map((p) => `"${p.packageJsonPath}"`).join(' ');
    }

    const biomeCommand = argv.fix && argv.format ? 'check --fix' : argv.fix ? 'lint --fix' : 'lint';
    if (biomeArgsText || files.length === 0) {
      void runWithSpawnInParallel(
        `bun --bun biome ${biomeCommand} --colors=force --no-errors-on-unmatched --files-ignore-unknown=true ${biomeArgsText}`,
        projects.self,
        argv,
        { forceColor: true }
      );
    }
    if (argv.format) {
      if (prettierArgsText) {
        void runWithSpawnInParallel(
          `bun --bun prettier --cache --color --write ${prettierArgsText}`,
          projects.self,
          argv,
          { forceColor: true }
        );
      }
      if (sortPackageJsonArgsText) {
        void runWithSpawnInParallel(`bun --bun sort-package-json ${sortPackageJsonArgsText}`, projects.self, argv, {
          forceColor: true,
        });
      }
    }
  },
};
