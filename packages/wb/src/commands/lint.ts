import path from 'node:path';

import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
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

const _argumentsBuilder = {
  files: {
    description: 'File and directory paths to lint',
    type: 'array',
  },
} as const;

const biomeExtensions = new Set(['cjs', 'cts', 'js', 'json', 'jsonc', 'jsx', 'mjs', 'mts', 'ts', 'tsx']);
const eslintExtensions = new Set(['cjs', 'cts', 'js', 'jsx', 'mjs', 'mts', 'ts', 'tsx']);
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
  InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder & typeof _argumentsBuilder>
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
    const lintFilePathsByProject = new Map<Project, string[]>();
    const prettierFilePaths: string[] = [];
    const packageJsonFilePaths: string[] = [];
    let missingLintToolForExplicitFiles = false;
    let prettierArgsText: string;
    let sortPackageJsonArgsText: string;
    if (files.length > 0) {
      for (const file of files) {
        const filePath = path.resolve(String(file));
        if (
          filePath.endsWith('/test/fixtures') ||
          filePath.includes('/test/fixtures/') ||
          filePath.endsWith('/test-fixtures') ||
          filePath.includes('/test-fixtures/')
        ) {
          continue;
        }

        const extension = path.extname(filePath).slice(1);
        if (filePath.endsWith('/package.json')) {
          packageJsonFilePaths.push(filePath);
          continue;
        }

        const project = findOwningProject(projects.descendants, filePath);
        if (!project) continue;

        if (supportsLintingExtension(project, extension)) {
          const lintFilePaths = lintFilePathsByProject.get(project) ?? [];
          lintFilePaths.push(filePath);
          lintFilePathsByProject.set(project, lintFilePaths);
        } else if (prettierExtensions.has(extension)) {
          prettierFilePaths.push(filePath);
        } else if (isPotentialLintTarget(extension) && !project.preferredLinter) {
          console.error(chalk.red(`No linter found for ${project.name}. Install ESLint or Biome.`));
          missingLintToolForExplicitFiles = true;
        }
      }
      prettierArgsText = prettierFilePaths.map((f) => `"${f}"`).join(' ');
      sortPackageJsonArgsText = packageJsonFilePaths.map((f) => `"${f}"`).join(' ');
    } else {
      prettierArgsText = `"**/{.*/,}*.{${[...prettierOnlyExtensions].join(',')}}" "!**/test{-,/}fixtures/**"`;
      sortPackageJsonArgsText = projects.descendants.map((p) => `"${p.packageJsonPath}"`).join(' ');
    }

    const lintPromises: Promise<number>[] = [];
    if (files.length > 0) {
      for (const [project, lintFilePaths] of lintFilePathsByProject) {
        const lintCommand = buildLintCommand(project, argv, lintFilePaths);
        if (!lintCommand) continue;

        lintPromises.push(runWithSpawnInParallel(lintCommand, project, argv, { forceColor: true }));
      }
    } else {
      for (const project of projects.descendants) {
        if (project.packageJson.workspaces && !project.hasSourceCode) continue;

        const lintCommand = buildLintCommand(project, argv);
        if (!lintCommand) continue;

        lintPromises.push(runWithSpawnInParallel(lintCommand, project, argv, { forceColor: true }));
      }
    }
    await Promise.all(lintPromises);

    if (missingLintToolForExplicitFiles) {
      process.exit(1);
    }

    if (argv.format) {
      if (prettierArgsText) {
        await runWithSpawnInParallel(
          `bun --bun prettier --cache --color --no-error-on-unmatched-pattern --write ${prettierArgsText}`,
          projects.self,
          argv,
          { forceColor: true }
        );
      }
      if (sortPackageJsonArgsText) {
        await runWithSpawnInParallel(`bun --bun sort-package-json ${sortPackageJsonArgsText}`, projects.self, argv, {
          forceColor: true,
        });
      }
    }
  },
};

export function buildLintCommand(
  project: Pick<Project, 'preferredLinter'>,
  argv: Pick<
    InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder & typeof _argumentsBuilder>,
    'fix' | 'format'
  >,
  files?: string[]
): string | undefined {
  const argsText =
    files?.map((filePath) => `"${filePath}"`).join(' ') || (project.preferredLinter === 'eslint' ? '.' : '');
  if (project.preferredLinter === 'biome') {
    const biomeCommand =
      argv.fix && argv.format ? 'check --fix' : argv.fix ? 'lint --fix' : argv.format ? 'format --fix' : 'lint';
    return `bun --bun biome ${biomeCommand} --colors=force --no-errors-on-unmatched --files-ignore-unknown=true ${argsText}`.trim();
  }
  if (project.preferredLinter === 'eslint') {
    return `bun --bun eslint --color ${argv.fix || argv.format ? '--fix ' : ''}${argsText}`.trim();
  }
  return;
}

function findOwningProject(projects: Project[], filePath: string): Project | undefined {
  return projects
    .filter((project) => filePath === project.dirPath || filePath.startsWith(`${project.dirPath}/`))
    .toSorted((a, b) => b.dirPath.length - a.dirPath.length)[0];
}

function isPotentialLintTarget(extension: string): boolean {
  return biomeExtensions.has(extension) || eslintExtensions.has(extension);
}

function supportsLintingExtension(project: Pick<Project, 'preferredLinter'>, extension: string): boolean {
  if (project.preferredLinter === 'biome') return biomeExtensions.has(extension);
  if (project.preferredLinter === 'eslint') return eslintExtensions.has(extension);
  return false;
}
