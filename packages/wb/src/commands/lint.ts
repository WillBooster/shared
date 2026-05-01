import fs from 'node:fs/promises';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
import type { BufferedRunResult } from '../scripts/run.js';
import { normalizeScript, runWithSpawnInParallel, runWithSpawnInParallelBuffered } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { printBufferedOutput } from '../utils/output.js';
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
  silent: {
    description: 'Print only failed or warning command output',
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
export type LintCommandArgv = ArgumentsCamelCase<LintCommandOptions> & {
  '--'?: unknown[];
  _: unknown[];
  printAllOutput?: boolean;
};

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

type BufferedLintRunResult = BufferedRunResult & { command: string; cwd: string };
type LintRunResult = BufferedLintRunResult | { exitCode: number };
interface LintRunCommand {
  command: string;
  project: Project;
}

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
          if (argv.format) {
            if (fileKind === 'directory' && project.hasOxfmt) {
              const oxfmtFilePaths = oxfmtFilePathsByProject.get(project) ?? [];
              oxfmtFilePaths.push(lintPath);
              oxfmtFilePathsByProject.set(project, oxfmtFilePaths);
              prettierFilePaths.push(buildPrettierOnlyDirectoryPattern(lintPath), prettierFixtureIgnorePattern);
            } else {
              for (const formatterPath of buildExplicitFormatterArgs(project, lintPath, fileKind, extension)) {
                if (project.hasOxfmt) {
                  const oxfmtFilePaths = oxfmtFilePathsByProject.get(project) ?? [];
                  oxfmtFilePaths.push(formatterPath);
                  oxfmtFilePathsByProject.set(project, oxfmtFilePaths);
                } else {
                  prettierFilePaths.push(formatterPath);
                }
              }
            }
          }
        } else if (argv.format && (prettierExtensions.has(extension) || oxfmtExtensions.has(extension))) {
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

  const formatterCommands: LintRunCommand[] = [];
  const linterCommands: LintRunCommand[] = [];
  const lintRunOptions = { exitIfFailed: false, forceColor: !argv.printAllOutput } as const;
  const shouldRunFormatters = Boolean(argv.format);
  const shouldRunLinters = !argv.format || Boolean(argv.fix);
  if (files.length > 0) {
    if (shouldRunLinters) {
      for (const [project, lintFilePaths] of lintFilePathsByProject) {
        const lintCommand = buildLintCommand(project, argv, lintFilePaths);
        if (!lintCommand) continue;

        linterCommands.push({ command: lintCommand, project });
      }
      for (const [project, pythonFilePaths] of pythonFilePathsByProject) {
        linterCommands.push({ command: buildPoetryLintCommand(argv, pythonFilePaths), project });
      }
      for (const [project, dartFilePaths] of dartFilePathsByProject) {
        linterCommands.push({ command: buildDartLintCommand(dartFilePaths), project });
      }
    }
    if (shouldRunFormatters) {
      for (const [project, oxfmtFilePaths] of oxfmtFilePathsByProject) {
        formatterCommands.push({ command: buildOxfmtCommand(oxfmtFilePaths), project });
      }
      for (const [project, pythonFilePaths] of pythonFilePathsByProject) {
        formatterCommands.push({ command: buildPoetryFormatCommand(pythonFilePaths), project });
      }
      for (const [project, dartFilePaths] of dartFilePathsByProject) {
        formatterCommands.push({ command: buildDartFormatCommand(dartFilePaths), project });
      }
    }
  } else {
    for (const project of projects.descendants) {
      if (shouldRunLinters && !(project.packageJson.workspaces && !project.hasSourceCode)) {
        const lintCommand = buildLintCommand(project, argv);
        if (lintCommand) linterCommands.push({ command: lintCommand, project });
      }
      if (shouldRunLinters) {
        if (project.hasPoetryLock) linterCommands.push({ command: buildPoetryLintCommand(argv), project });
        if (project.hasPubspecYaml) linterCommands.push({ command: buildDartLintCommand(), project });
      }
      if (shouldRunFormatters) {
        if (project.hasOxfmt) formatterCommands.push({ command: buildOxfmtCommand(), project });
        if (project.hasPoetryLock) formatterCommands.push({ command: buildPoetryFormatCommand(), project });
        if (project.hasPubspecYaml) formatterCommands.push({ command: buildDartFormatCommand(), project });
      }
    }
  }
  const lintExitCodes: number[] = [];

  if (shouldRunFormatters) {
    const formatterResults = await runLintCommands(formatterCommands, argv, lintRunOptions);
    printSilentLintOutputs(formatterResults, argv);
    lintExitCodes.push(...formatterResults.map((result) => result.exitCode));

    if (lintExitCodes.some((exitCode) => exitCode !== 0)) {
      return 1;
    }
  }

  if (missingLintToolForExplicitFiles) {
    return 1;
  }

  if (shouldRunFormatters) {
    if (prettierArgs.length > 0 && projects.self.hasPrettier) {
      const prettierResult = await runLintCommand(
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
        lintRunOptions
      );
      printSilentLintOutputs([prettierResult], argv);
      lintExitCodes.push(prettierResult.exitCode);
    }
    if (sortPackageJsonArgs.length > 0) {
      const sortPackageJsonResult = await runLintCommand(
        buildShellCommand(['YARN', 'sort-package-json', '--', ...sortPackageJsonArgs]),
        projects.self,
        argv,
        lintRunOptions
      );
      printSilentLintOutputs([sortPackageJsonResult], argv);
      lintExitCodes.push(sortPackageJsonResult.exitCode);
    }

    if (lintExitCodes.some((exitCode) => exitCode !== 0)) {
      return 1;
    }
  }

  if (shouldRunLinters) {
    const linterResults = await runLintCommands(linterCommands, argv, lintRunOptions);
    printSilentLintOutputs(linterResults, argv);
    lintExitCodes.push(...linterResults.map((result) => result.exitCode));
  }

  return lintExitCodes.some((exitCode) => exitCode !== 0) ? 1 : 0;
}

function runLintCommands(
  commands: LintRunCommand[],
  argv: LintCommandArgv,
  options: Parameters<typeof runWithSpawnInParallel>[3]
): Promise<LintRunResult[]> {
  return Promise.all(commands.map(({ command, project }) => runLintCommand(command, project, argv, options)));
}

function runLintCommand(
  command: string,
  project: Project,
  argv: LintCommandArgv,
  options: Parameters<typeof runWithSpawnInParallel>[3]
): Promise<LintRunResult> {
  if (argv.silent) {
    const normalizedScript = normalizeScript(command, project);
    return runWithSpawnInParallelBuffered(command, project, argv, options).then((result) => ({
      ...result,
      command: normalizedScript.printable,
      cwd: project.dirPath,
    }));
  }
  return runWithSpawnInParallel(command, project, argv, options).then((exitCode) => ({ exitCode }));
}

function printSilentLintOutputs(
  results: LintRunResult[],
  argv: Pick<LintCommandArgv, 'printAllOutput' | 'silent'>
): void {
  const printableResults =
    argv.silent && !argv.printAllOutput ? results.filter((result) => result.exitCode !== 0) : results;
  if (printableResults.length === 0) return;

  for (const result of printableResults) {
    if (!('output' in result)) continue;

    if (argv.printAllOutput) {
      printCommandOutput(result);
    } else {
      if (argv.silent) {
        printCommandHeader(result.command, result.cwd);
      }
      printBufferedOutput(result.exitCode, result.output);
    }
  }
}

function printCommandOutput(result: BufferedLintRunResult): void {
  printCommandHeader(result.command, result.cwd);

  if (result.exitCode === 0 && shouldSuppressSuccessfulVerifyOutput(result.command)) {
    console.info(chalk.green('Succeeded.'));
    return;
  }

  const output = result.output.trim();
  if (output) {
    process.stdout.write(output);
    process.stdout.write('\n');
  }
}

function printCommandHeader(command: string, cwd: string): void {
  console.info('\n' + chalk.cyan(chalk.bold('Command:'), command) + chalk.gray(` at ${cwd}`));
}

function shouldSuppressSuccessfulVerifyOutput(command: string): boolean {
  return command.includes(' oxfmt ') || command.includes(' sort-package-json ');
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
      '--no-error-on-unmatched-pattern',
      ...(argv.quiet ? ['--quiet'] : []),
      ...(argv.fix ? ['--fix'] : []),
      ...(files ?? ['.']),
    ]);
  }
  return;
}

export function buildOxfmtCommand(files?: string[]): string {
  return buildShellCommand([
    'YARN',
    'oxfmt',
    '--write',
    '--no-error-on-unmatched-pattern',
    ...(files ?? ['.']),
    '!**/package.json',
  ]);
}

export function buildPoetryFormatCommand(files?: string[]): string {
  const targets = files && files.length > 0 ? files : ['.'];
  return [
    buildShellCommand(['poetry', 'run', 'isort', '--profile', 'black', '--filter-files', ...targets]),
    buildShellCommand(['poetry', 'run', 'black', ...targets]),
  ].join(' && ');
}

export function buildPoetryLintCommand(argv: Partial<Pick<LintCommandOptions, 'quiet'>>, files?: string[]): string {
  const targets = files && files.length > 0 ? files : ['.'];
  return buildShellCommand(['poetry', 'run', 'flake8', ...(argv.quiet ? ['-q'] : []), ...targets]);
}

export function buildDartFormatCommand(files?: string[]): string {
  const targets = files && files.length > 0 ? files : ['.'];
  return buildShellCommand(['dart', 'format', ...targets]);
}

export function buildDartLintCommand(files?: string[]): string {
  const targets = files && files.length > 0 ? files : ['.'];
  return buildShellCommand(['dart', 'analyze', ...targets]);
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

function buildPrettierOnlyDirectoryPattern(filePath: string): string {
  return path.join(filePath, `**/{.*/,}*.{${[...prettierOnlyExtensions].join(',')}}`);
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
