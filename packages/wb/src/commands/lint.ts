import fs from 'node:fs/promises';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
import { runWithSpawnInParallel } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { buildShellCommand } from '../utils/shell.js';

const builder = {
  fix: {
    description: 'Fix the linting errors',
    type: 'boolean',
  },
  format: {
    description: 'Format the code',
    type: 'boolean',
  },
  quiet: {
    description: 'Report errors only',
    type: 'boolean',
  },
} as const;

const _argumentsBuilder = {
  files: {
    description: 'File and directory paths to lint',
    type: 'array',
  },
} as const;

export type LintCommandOptions = InferredOptionTypes<
  typeof builder & typeof sharedOptionsBuilder & typeof _argumentsBuilder
>;
export type LintCommandArgv = ArgumentsCamelCase<LintCommandOptions> & { '--'?: unknown[]; _: unknown[] };

const oxlintExtensions = new Set(['astro', 'cjs', 'cts', 'js', 'jsx', 'mjs', 'mts', 'svelte', 'ts', 'tsx', 'vue']);
const pythonExtensions = new Set(['py']);
const dartExtensions = new Set(['dart']);
const oxfmtExtensions = new Set([
  ...oxlintExtensions,
  'css',
  'gql',
  'graphql',
  'hbs',
  'htm',
  'html',
  'json',
  'json5',
  'jsonc',
  'less',
  'md',
  'mdx',
  'scss',
  'toml',
  'yaml',
  'yml',
]);
const prettierExtensions = new Set([
  'cjs',
  'css',
  'cts',
  'htm',
  'html',
  'java',
  'js',
  'json',
  'json5',
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
const prettierOnlyExtensions = new Set([...prettierExtensions].filter((ext) => !oxfmtExtensions.has(ext)));
const prettierFixtureIgnorePattern = '!**/test{-,/}fixtures/**';
const oxlintFixtureIgnorePattern = '**/test{-,/}fixtures/**';

export const lintCommand: CommandModule<unknown, LintCommandOptions> = {
  command: 'lint [files...]',
  describe: 'Lint code',
  builder,
  async handler(argv) {
    const exitCode = await lint(argv as LintCommandArgv);
    if (exitCode) process.exit(exitCode);
  },
};

export async function lint(argv: LintCommandArgv): Promise<number> {
  if (process.platform === 'win32') {
    console.error(chalk.red('This command is not supported on Windows.'));
    return 1;
  }

  const projects = await findDescendantProjects(argv, false);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    return 1;
  }

  const files = getLintTargetFiles(argv);
  const lintFilePathsByProject = new Map<Project, string[]>();
  const oxfmtFilePathsByProject = new Map<Project, string[]>();
  const pythonFilePathsByProject = new Map<Project, string[]>();
  const dartFilePathsByProject = new Map<Project, string[]>();
  const prettierFilePaths: string[] = [];
  const packageJsonFilePaths: string[] = [];
  let missingLintToolForExplicitFiles = false;
  let prettierArgs: string[];
  let sortPackageJsonArgs: string[];
  if (files.length > 0) {
    const lintTargets = await Promise.all(
      files.map(async (file) => {
        const filePath = path.resolve(file);
        const fileKind = await getLintTargetFileKind(filePath);
        return { fileKind, filePath };
      })
    );
    for (const { fileKind, filePath } of lintTargets) {
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
      packageJsonFilePaths.push(...getExplicitPackageJsonPaths(projects.descendants, filePath, fileKind));

      for (const { lintPath, project } of getExplicitLintTargets(projects.descendants, filePath, fileKind)) {
        if (project.hasPoetryLock && (fileKind === 'directory' || pythonExtensions.has(extension))) {
          const pythonFilePaths = pythonFilePathsByProject.get(project) ?? [];
          pythonFilePaths.push(lintPath);
          pythonFilePathsByProject.set(project, pythonFilePaths);
          if (fileKind !== 'directory') continue;
        }
        if (project.hasPubspecYaml && (fileKind === 'directory' || dartExtensions.has(extension))) {
          const dartFilePaths = dartFilePathsByProject.get(project) ?? [];
          dartFilePaths.push(lintPath);
          dartFilePathsByProject.set(project, dartFilePaths);
          if (fileKind !== 'directory') continue;
        }
        if (fileKind === 'directory' || supportsLintingExtension(project, extension)) {
          const lintFilePaths = lintFilePathsByProject.get(project) ?? [];
          lintFilePaths.push(lintPath);
          lintFilePathsByProject.set(project, lintFilePaths);
          for (const formatterPath of buildExplicitFormatterArgs(project, lintPath, fileKind, extension)) {
            if (project.hasOxfmt) {
              const oxfmtFilePaths = oxfmtFilePathsByProject.get(project) ?? [];
              oxfmtFilePaths.push(formatterPath);
              oxfmtFilePathsByProject.set(project, oxfmtFilePaths);
            } else {
              prettierFilePaths.push(formatterPath);
            }
          }
        } else if (prettierExtensions.has(extension) || oxfmtExtensions.has(extension)) {
          if (project.hasOxfmt && oxfmtExtensions.has(extension)) {
            const oxfmtFilePaths = oxfmtFilePathsByProject.get(project) ?? [];
            oxfmtFilePaths.push(lintPath);
            oxfmtFilePathsByProject.set(project, oxfmtFilePaths);
          } else if (prettierExtensions.has(extension)) {
            prettierFilePaths.push(lintPath);
          }
        } else if (isPotentialLintTarget(extension) && !project.preferredLinter) {
          console.error(chalk.red(`No linter found for ${project.name}. Install Oxlint.`));
          missingLintToolForExplicitFiles = true;
        }
      }
    }
    prettierArgs = [...new Set(prettierFilePaths)];
    sortPackageJsonArgs = [...new Set(packageJsonFilePaths)];
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
    for (const [project, oxfmtFilePaths] of oxfmtFilePathsByProject) {
      lintPromises.push(runWithSpawnInParallel(buildOxfmtCommand(oxfmtFilePaths), project, argv, lintRunOptions));
    }
    for (const [project, pythonFilePaths] of pythonFilePathsByProject) {
      lintPromises.push(
        runWithSpawnInParallel(buildPoetryCommand(argv, pythonFilePaths), project, argv, lintRunOptions)
      );
    }
    for (const [project, dartFilePaths] of dartFilePathsByProject) {
      lintPromises.push(runWithSpawnInParallel(buildDartCommand(argv, dartFilePaths), project, argv, lintRunOptions));
    }
  } else {
    for (const project of projects.descendants) {
      if (project.packageJson.workspaces && !project.hasSourceCode) continue;

      const lintCommand = buildLintCommand(project, argv);
      if (!lintCommand) continue;

      lintPromises.push(runWithSpawnInParallel(lintCommand, project, argv, lintRunOptions));
    }
    for (const project of projects.descendants) {
      if (project.hasPoetryLock) {
        lintPromises.push(runWithSpawnInParallel(buildPoetryCommand(argv), project, argv, lintRunOptions));
      }
      if (project.hasPubspecYaml) {
        lintPromises.push(runWithSpawnInParallel(buildDartCommand(argv), project, argv, lintRunOptions));
      }
      if (project.hasOxfmt && argv.format) {
        lintPromises.push(runWithSpawnInParallel(buildOxfmtCommand(), project, argv, lintRunOptions));
      }
    }
  }
  const lintExitCodes = await Promise.all(lintPromises);

  if (missingLintToolForExplicitFiles || lintExitCodes.some((exitCode) => exitCode !== 0)) {
    return 1;
  }

  if (argv.format) {
    if (prettierArgs.length > 0) {
      lintExitCodes.push(
        await runWithSpawnInParallel(
          buildShellCommand([
            'YARN',
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
          { exitIfFailed: false, forceColor: true }
        )
      );
    }
    if (sortPackageJsonArgs.length > 0) {
      lintExitCodes.push(
        await runWithSpawnInParallel(
          buildShellCommand(['YARN', 'sort-package-json', '--', ...sortPackageJsonArgs]),
          projects.self,
          argv,
          { exitIfFailed: false, forceColor: true }
        )
      );
    }
  }

  return lintExitCodes.some((exitCode) => exitCode !== 0) ? 1 : 0;
}

export function buildLintCommand(
  project: Pick<Project, 'preferredLinter'>,
  argv: Pick<LintCommandOptions, 'fix' | 'format'> & Partial<Pick<LintCommandOptions, 'quiet'>>,
  files?: string[]
): string | undefined {
  if (project.preferredLinter === 'oxlint') {
    return buildShellCommand([
      'YARN',
      'oxlint',
      ...(argv.quiet ? ['--quiet'] : []),
      ...(argv.fix ? ['--fix'] : []),
      '--ignore-pattern',
      oxlintFixtureIgnorePattern,
      ...(files ?? ['.']),
    ]);
  }
  return;
}

export function buildOxfmtCommand(files?: string[]): string {
  const configPath = `"$(node -e 'console.log(require.resolve("@willbooster/oxfmt-config/.oxfmtrc.json"))')"`;
  return `${buildShellCommand([
    'YARN',
    'oxfmt',
    '--write',
    '--no-error-on-unmatched-pattern',
    '-c',
  ])} ${configPath} ${buildShellCommand(files ?? ['.'])}`;
}

export function buildPoetryCommand(
  argv: Pick<LintCommandOptions, 'fix' | 'format'> & Partial<Pick<LintCommandOptions, 'quiet'>>,
  files?: string[]
): string {
  const targets = files && files.length > 0 ? files : ['.'];
  const commands =
    argv.fix || argv.format
      ? [
          buildShellCommand(['poetry', 'run', 'isort', '--profile', 'black', '--filter-files', ...targets]),
          buildShellCommand(['poetry', 'run', 'black', ...targets]),
          buildShellCommand(['poetry', 'run', 'flake8', ...(argv.quiet ? ['-q'] : []), ...targets]),
        ]
      : [buildShellCommand(['poetry', 'run', 'flake8', ...(argv.quiet ? ['-q'] : []), ...targets])];
  return commands.join(' && ');
}

export function buildDartCommand(
  argv: Pick<LintCommandOptions, 'fix' | 'format'> & Partial<Pick<LintCommandOptions, 'quiet'>>,
  files?: string[]
): string {
  const targets = files && files.length > 0 ? files : ['.'];
  const commands: string[] = [];
  if (argv.fix || argv.format) {
    commands.push(buildShellCommand(['dart', 'format', ...targets]));
  }
  commands.push(buildShellCommand(['dart', 'analyze', ...targets]));
  return commands.join(' && ');
}

export function buildPrettierArgs(
  selfDirPath: string,
  projects: Pick<Project, 'dirPath' | 'preferredLinter' | 'hasOxfmt'>[]
): string[] {
  const args = new Set<string>([`**/{.*/,}*.{${[...prettierOnlyExtensions].join(',')}}`, prettierFixtureIgnorePattern]);
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

export function getLintTargetFiles(argv: Pick<LintCommandArgv, '--' | '_' | 'files'>): string[] {
  const lintTargets = new Set<string>();
  for (const value of [...(argv.files ?? []), ...argv._.slice(1), ...(argv['--'] ?? [])]) {
    lintTargets.add(String(value));
  }
  return [...lintTargets];
}

export async function getLintTargetFileKind(filePath: string): Promise<'directory' | 'other'> {
  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) return 'directory';
  } catch {
    // Missing paths are handled by the downstream tools.
  }

  return 'other';
}

export function shouldFormatExplicitPathWithPrettier(
  project: Pick<Project, 'preferredLinter' | 'hasOxfmt'>,
  extension: string
): boolean {
  if (project.hasOxfmt) return oxfmtExtensions.has(extension);
  if (needsPrettier(project)) return true;
  return prettierOnlyExtensions.has(extension);
}

export function buildExplicitFormatterArgs(
  project: Pick<Project, 'preferredLinter' | 'hasOxfmt'>,
  filePath: string,
  fileKind: 'directory' | 'other',
  extension: string
): string[] {
  if (fileKind === 'directory' && project.hasOxfmt) {
    return [filePath];
  }
  if (fileKind === 'directory' && needsPrettier(project)) {
    return [filePath, prettierFixtureIgnorePattern];
  }
  if (shouldFormatExplicitPathWithPrettier(project, extension)) {
    return [filePath];
  }
  return [];
}

export function getExplicitPackageJsonPaths(
  projects: Pick<Project, 'dirPath' | 'packageJsonPath'>[],
  filePath: string,
  fileKind: 'directory' | 'other'
): string[] {
  if (fileKind !== 'directory') return [];
  return projects
    .filter(
      (project) =>
        project.packageJsonPath === path.join(filePath, 'package.json') ||
        project.packageJsonPath.startsWith(`${filePath}/`)
    )
    .map((project) => project.packageJsonPath);
}

export function getExplicitLintTargets(
  projects: Project[],
  filePath: string,
  fileKind: 'directory' | 'other'
): { lintPath: string; project: Project }[] {
  if (fileKind === 'directory') {
    const descendantProjects = projects.filter(
      (project) => project.dirPath === filePath || project.dirPath.startsWith(`${filePath}/`)
    );
    if (descendantProjects.length > 0) {
      return descendantProjects.map((project) => ({ lintPath: project.dirPath, project }));
    }
  }

  const project = findOwningProject(projects, filePath);
  return project ? [{ lintPath: filePath, project }] : [];
}

function isPotentialLintTarget(extension: string): boolean {
  return oxlintExtensions.has(extension) || pythonExtensions.has(extension) || dartExtensions.has(extension);
}

function supportsLintingExtension(project: Pick<Project, 'preferredLinter'>, extension: string): boolean {
  if (project.preferredLinter === 'oxlint') return oxlintExtensions.has(extension);
  return false;
}

function needsPrettier(project: Pick<Project, 'preferredLinter' | 'hasOxfmt'>): boolean {
  return !project.hasOxfmt && project.preferredLinter === 'oxlint';
}
