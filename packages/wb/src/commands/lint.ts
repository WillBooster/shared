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
    if (process.platform === 'win32') {
      console.error(chalk.red('This command is not supported on Windows.'));
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
    let prettierArgs: string[];
    let sortPackageJsonArgs: string[];
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
          if (needsPrettier(project)) {
            prettierFilePaths.push(filePath);
          }
        } else if (prettierExtensions.has(extension)) {
          prettierFilePaths.push(filePath);
        } else if (isPotentialLintTarget(extension) && !project.preferredLinter) {
          console.error(chalk.red(`No linter found for ${project.name}. Install ESLint or Biome.`));
          missingLintToolForExplicitFiles = true;
        }
      }
      prettierArgs = prettierFilePaths;
      sortPackageJsonArgs = packageJsonFilePaths;
    } else {
      prettierArgs = buildPrettierArgs(projects.self.dirPath, projects.descendants);
      sortPackageJsonArgs = projects.descendants.map((p) => p.packageJsonPath);
    }

    const lintPromises: Promise<number>[] = [];
    const lintRunOptions = { exitIfFailed: false, forceColor: true } as const;
    if (files.length > 0) {
      for (const [project, lintFilePaths] of lintFilePathsByProject) {
        const lintCommand = buildLintCommand(project, argv, lintFilePaths);
        if (!lintCommand) continue;

        lintPromises.push(runWithSpawnInParallel(lintCommand, project, argv, lintRunOptions));
      }
    } else {
      for (const project of projects.descendants) {
        if (project.packageJson.workspaces && !project.hasSourceCode) continue;

        const lintCommand = buildLintCommand(project, argv);
        if (!lintCommand) continue;

        lintPromises.push(runWithSpawnInParallel(lintCommand, project, argv, lintRunOptions));
      }
    }
    const lintExitCodes = await Promise.all(lintPromises);

    if (missingLintToolForExplicitFiles || lintExitCodes.some((exitCode) => exitCode !== 0)) {
      process.exit(1);
    }

    if (argv.format) {
      if (prettierArgs.length > 0) {
        await runWithSpawnInParallel(
          buildShellCommand([
            'bun',
            '--bun',
            'prettier',
            '--cache',
            '--color',
            '--no-error-on-unmatched-pattern',
            '--write',
            '--',
            ...prettierArgs,
          ]),
          projects.self,
          argv,
          { forceColor: true }
        );
      }
      if (sortPackageJsonArgs.length > 0) {
        await runWithSpawnInParallel(
          buildShellCommand(['bun', '--bun', 'sort-package-json', '--', ...sortPackageJsonArgs]),
          projects.self,
          argv,
          {
            forceColor: true,
          }
        );
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
  if (project.preferredLinter === 'biome') {
    let biomeArgs: string[];
    if (argv.fix && argv.format) {
      biomeArgs = ['check', '--fix'];
    } else if (argv.fix) {
      biomeArgs = ['lint', '--fix'];
    } else if (argv.format) {
      biomeArgs = ['format', '--fix'];
    } else {
      biomeArgs = ['lint'];
    }
    return buildShellCommand([
      'bun',
      '--bun',
      'biome',
      ...biomeArgs,
      '--colors=force',
      '--no-errors-on-unmatched',
      '--files-ignore-unknown=true',
      ...(files?.length ? ['--'] : []),
      ...(files ?? []),
    ]);
  }
  if (project.preferredLinter === 'eslint') {
    return buildShellCommand([
      'bun',
      '--bun',
      'eslint',
      '--color',
      ...(argv.fix || argv.format ? ['--fix'] : []),
      '--',
      ...(files ?? ['.']),
    ]);
  }
  return;
}

export function buildPrettierArgs(
  selfDirPath: string,
  projects: Pick<Project, 'dirPath' | 'preferredLinter'>[]
): string[] {
  const args = new Set<string>([`**/{.*/,}*.{${[...prettierOnlyExtensions].join(',')}}`, '!**/test{-,/}fixtures/**']);
  for (const project of projects) {
    if (!needsPrettier(project)) continue;

    const projectPattern = path.join(project.dirPath, '**/{.*/,}*.{' + [...prettierExtensions].join(',') + '}');
    args.add(path.relative(selfDirPath, projectPattern) || projectPattern);
  }
  return [...args];
}

function findOwningProject(projects: Project[], filePath: string): Project | undefined {
  let owningProject: Project | undefined;
  for (const project of projects) {
    if (
      (filePath === project.dirPath || filePath.startsWith(`${project.dirPath}/`)) &&
      (!owningProject || project.dirPath.length > owningProject.dirPath.length)
    ) {
      owningProject = project;
    }
  }
  return owningProject;
}

function isPotentialLintTarget(extension: string): boolean {
  return biomeExtensions.has(extension) || eslintExtensions.has(extension);
}

function supportsLintingExtension(project: Pick<Project, 'preferredLinter'>, extension: string): boolean {
  if (project.preferredLinter === 'biome') return biomeExtensions.has(extension);
  if (project.preferredLinter === 'eslint') return eslintExtensions.has(extension);
  return false;
}

function needsPrettier(project: Pick<Project, 'preferredLinter'>): boolean {
  return project.preferredLinter === 'eslint';
}

function buildShellCommand(args: string[]): string {
  return args.map((arg) => shellEscapeArgument(arg)).join(' ');
}

function shellEscapeArgument(arg: string): string {
  return /^[\w./:=,@%+-]+$/u.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`;
}
