import fs from 'node:fs/promises';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { FoundProjects, Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
import type { BufferedRunResult } from '../scripts/run.js';
import { normalizeScript, runWithSpawnInParallel, runWithSpawnInParallelBuffered } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { printBufferedOutput, shouldPrintBufferedOutput } from '../utils/output.js';
import { buildShellCommand } from '../utils/shell.js';
import { reportTestStructureViolations } from '../utils/testStructure.js';
import { isCapturingVerificationOutput } from '../utils/verificationOutput.js';

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

type LintCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder & typeof _argumentsBuilder>;
export type LintCommandArgv = ArgumentsCamelCase<LintCommandOptions> & {
  '--'?: unknown[];
  _: unknown[];
  printAllOutput?: boolean;
};

const oxlintExtensions = new Set(['astro', 'cjs', 'cts', 'js', 'jsx', 'mjs', 'mts', 'svelte', 'ts', 'tsx', 'vue']);
const pythonExtensions = new Set(['py']);
const dartExtensions = new Set(['dart']);
const rustExtensions = new Set(['rs']);
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
  // The test layout is a static structural rule, so `wb lint` is its home: `wb verify` (via its
  // cleanup step) and CI's lint job then enforce it with no extra wiring, and a stray test file
  // surfaces here instead of at `wb test`, where `--passWithNoTests` would otherwise let the suite
  // pass while silently running none of it. Reported before the linters run so the diagnosis leads
  // the output, but never short-circuits them: `--fix --format` must still clean up what it can,
  // because a layout violation is not auto-fixable and would otherwise block every other fix.
  // Three run shapes opt out. Explicit-path runs (e.g. the lefthook pre-commit hook) skip it so a
  // pre-existing violation in an untouched package cannot block an unrelated commit. `--dry-run`
  // skips it so this stays the one step that could fail a run whose whole contract is to execute
  // nothing. Formatter-only runs (`--format` without `--fix`) skip it because they lint nothing at
  // all, and wbfy chains that script as `bun wb lint --format && bun run format-code` for Dart and
  // Python repositories — failing it there would silently strip their only formatting pass.
  const violatesTestStructure =
    shouldRunLinters(argv) && !argv.dryRun && files.length === 0 && reportTestStructureViolations(projects.descendants);
  const plan =
    files.length > 0 ? await planExplicitLintRun(argv, projects.descendants, files) : planWholeLintRun(argv, projects);
  const succeeded = await runLintPlan(plan, argv, projects.self);
  return succeeded && !violatesTestStructure ? 0 : 1;
}

function shouldRunFormatters(argv: LintCommandArgv): boolean {
  return Boolean(argv.format);
}

function shouldRunLinters(argv: LintCommandArgv): boolean {
  return !argv.format || Boolean(argv.fix);
}

interface LintPlan {
  formatterCommands: LintRunCommand[];
  linterCommands: LintRunCommand[];
  prettierArgs: string[];
  sortPackageJsonArgs: string[];
  /** Whether an explicitly passed file needs a linter that its project lacks. */
  missingLintTool: boolean;
}

function planWholeLintRun(argv: LintCommandArgv, projects: FoundProjects): LintPlan {
  const formatterCommands: LintRunCommand[] = [];
  const linterCommands: LintRunCommand[] = [];
  for (const project of projects.descendants) {
    if (shouldRunLinters(argv)) {
      const lintCommand = buildLintCommand(
        project,
        argv,
        undefined,
        buildWorkspaceIgnorePatterns(
          project,
          projects.descendants,
          // The same command: a workspace that lints without the root's type check stays covered.
          (workspace) => buildLintCommand(workspace, argv) === buildLintCommand(project, argv)
        )
      );
      if (lintCommand) linterCommands.push({ command: lintCommand, project });
      if (project.hasPoetryLock) linterCommands.push({ command: buildPoetryLintCommand(argv), project });
      if (project.hasPubspecYaml) linterCommands.push({ command: buildDartLintCommand(), project });
    }
    if (shouldRunFormatters(argv)) {
      if (project.hasOxfmt) formatterCommands.push({ command: buildOxfmtCommand(), project });
      if (project.hasPoetryLock) formatterCommands.push({ command: buildPoetryFormatCommand(), project });
      if (project.hasPubspecYaml) formatterCommands.push({ command: buildDartFormatCommand(), project });
      if (project.hasCargoToml) formatterCommands.push({ command: buildCargoFormatCommand(), project });
    }
  }
  return {
    formatterCommands,
    linterCommands,
    prettierArgs: buildPrettierArgs(projects.self.dirPath, projects.descendants),
    sortPackageJsonArgs: projects.descendants.map((p) => p.packageJsonPath),
    missingLintTool: false,
  };
}

interface ExplicitLintTargets {
  lintFilePathsByProject: Map<Project, string[]>;
  oxfmtFilePathsByProject: Map<Project, string[]>;
  pythonFilePathsByProject: Map<Project, string[]>;
  dartFilePathsByProject: Map<Project, string[]>;
  // `cargo fmt --all` always formats the whole workspace, so we track target
  // projects rather than individual file paths. Every project with its own
  // `Cargo.toml` runs its own `cargo fmt --all`; we intentionally do not dedup
  // by directory. A nested or sibling crate can be an independent Cargo
  // workspace that a parent's `cargo fmt --all` never reaches, so skipping it
  // would leave it unformatted, while any genuinely overlapping runs are
  // harmless because rustfmt is deterministic and idempotent. Deduping by real
  // workspace membership would require invoking `cargo locate-project`.
  cargoFormatProjects: Set<Project>;
  prettierFilePaths: string[];
  packageJsonFilePaths: string[];
  missingLintTool: boolean;
}

interface ExplicitLintTarget {
  lintPath: string;
  fileKind: 'directory' | 'other';
  extension: string;
}

async function planExplicitLintRun(argv: LintCommandArgv, projects: Project[], files: string[]): Promise<LintPlan> {
  const targets: ExplicitLintTargets = {
    lintFilePathsByProject: new Map(),
    oxfmtFilePathsByProject: new Map(),
    pythonFilePathsByProject: new Map(),
    dartFilePathsByProject: new Map(),
    cargoFormatProjects: new Set(),
    prettierFilePaths: [],
    packageJsonFilePaths: [],
    missingLintTool: false,
  };
  const explicitPaths = await Promise.all(
    files.map(async (file) => {
      const filePath = path.resolve(file);
      const fileKind = await getLintTargetFileKind(filePath);
      return { fileKind, filePath };
    })
  );
  for (const { fileKind, filePath } of explicitPaths) {
    if (isInTestFixtures(filePath)) continue;
    if (filePath.endsWith('/package.json')) {
      targets.packageJsonFilePaths.push(filePath);
      continue;
    }
    targets.packageJsonFilePaths.push(...getExplicitPackageJsonPaths(projects, filePath, fileKind));

    const extension = path.extname(filePath).slice(1);
    for (const { lintPath, project } of getExplicitLintTargets(projects, filePath, fileKind)) {
      classifyExplicitLintTarget(targets, argv, project, { lintPath, fileKind, extension });
    }
  }
  return {
    ...buildExplicitLintCommands(targets, argv),
    prettierArgs: [...new Set(targets.prettierFilePaths)],
    sortPackageJsonArgs: [...new Set(targets.packageJsonFilePaths)],
    missingLintTool: targets.missingLintTool,
  };
}

function isInTestFixtures(filePath: string): boolean {
  return (
    filePath.endsWith('/test/fixtures') ||
    filePath.includes('/test/fixtures/') ||
    filePath.endsWith('/test-fixtures') ||
    filePath.includes('/test-fixtures/')
  );
}

function classifyExplicitLintTarget(
  targets: ExplicitLintTargets,
  argv: LintCommandArgv,
  project: Project,
  target: ExplicitLintTarget
): void {
  const { lintPath, extension } = target;
  const isDirectory = target.fileKind === 'directory';
  if (project.hasPoetryLock && (isDirectory || pythonExtensions.has(extension))) {
    appendPath(targets.pythonFilePathsByProject, project, lintPath);
    if (!isDirectory) return;
  }
  if (project.hasPubspecYaml && (isDirectory || dartExtensions.has(extension))) {
    appendPath(targets.dartFilePathsByProject, project, lintPath);
    if (!isDirectory) return;
  }
  if (project.hasCargoToml && (isDirectory || rustExtensions.has(extension))) {
    targets.cargoFormatProjects.add(project);
    if (!isDirectory) return;
  }
  if (isDirectory || supportsLintingExtension(project, extension)) {
    appendPath(targets.lintFilePathsByProject, project, lintPath);
    if (argv.format) addFormatterPathsOfLintTarget(targets, project, target);
  } else if (argv.format && (prettierExtensions.has(extension) || oxfmtExtensions.has(extension))) {
    if (project.hasOxfmt && oxfmtExtensions.has(extension)) {
      appendPath(targets.oxfmtFilePathsByProject, project, lintPath);
    } else if (prettierExtensions.has(extension)) {
      targets.prettierFilePaths.push(lintPath);
    }
  } else if (isPotentialLintTarget(extension) && !project.preferredLinter) {
    console.error(chalk.red(`No linter found for ${project.name}. Install Oxlint.`));
    targets.missingLintTool = true;
  }
}

function addFormatterPathsOfLintTarget(
  targets: ExplicitLintTargets,
  project: Project,
  { lintPath, fileKind, extension }: ExplicitLintTarget
): void {
  if (fileKind === 'directory' && project.hasOxfmt) {
    appendPath(targets.oxfmtFilePathsByProject, project, lintPath);
    targets.prettierFilePaths.push(buildPrettierOnlyDirectoryPattern(lintPath), prettierFixtureIgnorePattern);
    return;
  }
  for (const formatterPath of buildExplicitFormatterArgs(project, lintPath, fileKind, extension)) {
    if (project.hasOxfmt) {
      appendPath(targets.oxfmtFilePathsByProject, project, formatterPath);
    } else {
      targets.prettierFilePaths.push(formatterPath);
    }
  }
}

function appendPath(filePathsByProject: Map<Project, string[]>, project: Project, filePath: string): void {
  const filePaths = filePathsByProject.get(project) ?? [];
  filePaths.push(filePath);
  filePathsByProject.set(project, filePaths);
}

function buildExplicitLintCommands(
  targets: ExplicitLintTargets,
  argv: LintCommandArgv
): Pick<LintPlan, 'formatterCommands' | 'linterCommands'> {
  const formatterCommands: LintRunCommand[] = [];
  const linterCommands: LintRunCommand[] = [];
  if (shouldRunLinters(argv)) {
    for (const [project, lintFilePaths] of targets.lintFilePathsByProject) {
      const lintCommand = buildLintCommand(project, argv, lintFilePaths);
      if (lintCommand) linterCommands.push({ command: lintCommand, project });
    }
  }
  for (const [project, pythonFilePaths] of targets.pythonFilePathsByProject) {
    if (shouldRunLinters(argv)) {
      linterCommands.push({ command: buildPoetryLintCommand(argv, pythonFilePaths), project });
    }
    if (shouldRunFormatters(argv)) {
      formatterCommands.push({ command: buildPoetryFormatCommand(pythonFilePaths), project });
    }
  }
  for (const [project, dartFilePaths] of targets.dartFilePathsByProject) {
    if (shouldRunLinters(argv)) {
      linterCommands.push({ command: buildDartLintCommand(dartFilePaths), project });
    }
    if (shouldRunFormatters(argv)) {
      formatterCommands.push({ command: buildDartFormatCommand(dartFilePaths), project });
    }
  }
  if (shouldRunFormatters(argv)) {
    for (const project of targets.cargoFormatProjects) {
      formatterCommands.push({ command: buildCargoFormatCommand(), project });
    }
    for (const [project, oxfmtFilePaths] of targets.oxfmtFilePathsByProject) {
      formatterCommands.push({ command: buildOxfmtCommand(oxfmtFilePaths), project });
    }
  }
  return { formatterCommands, linterCommands };
}

/** Resolves to whether every command succeeded. */
async function runLintPlan(plan: LintPlan, argv: LintCommandArgv, selfProject: Project): Promise<boolean> {
  if (shouldRunFormatters(argv) && !(await runAndReportLintCommands(plan.formatterCommands, argv))) return false;
  if (plan.missingLintTool) return false;
  if (shouldRunFormatters(argv) && !(await runRootFormatters(plan, argv, selfProject))) return false;
  return !shouldRunLinters(argv) || (await runAndReportLintCommands(plan.linterCommands, argv));
}

async function runAndReportLintCommands(commands: LintRunCommand[], argv: LintCommandArgv): Promise<boolean> {
  const results = await runLintCommands(commands, argv, buildLintRunOptions(argv));
  printSilentLintOutputs(results, argv);
  return results.every((result) => result.exitCode === 0);
}

async function runRootFormatters(plan: LintPlan, argv: LintCommandArgv, selfProject: Project): Promise<boolean> {
  const commands: string[] = [];
  if (plan.prettierArgs.length > 0 && selfProject.hasPrettier) {
    commands.push(
      buildShellCommand([
        'YARN',
        'prettier',
        '--cache',
        '--no-error-on-unmatched-pattern',
        '--write',
        '--',
        ...plan.prettierArgs,
      ])
    );
  }
  if (plan.sortPackageJsonArgs.length > 0) {
    commands.push(buildShellCommand(['YARN', 'sort-package-json', '--', ...plan.sortPackageJsonArgs]));
  }
  let succeeded = true;
  for (const command of commands) {
    const result = await runLintCommand(command, selfProject, argv, buildLintRunOptions(argv));
    printSilentLintOutputs([result], argv);
    succeeded &&= result.exitCode === 0;
  }
  return succeeded;
}

function buildLintRunOptions(argv: LintCommandArgv): Parameters<typeof runWithSpawnInParallel>[3] {
  return { exitIfFailed: false, preserveColor: !argv.printAllOutput };
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
  if (isCapturingVerificationOutput()) return;
  const printableResults =
    argv.silent && !argv.printAllOutput
      ? results.filter((result) => 'output' in result && shouldPrintBufferedOutput(result.exitCode, result.output))
      : results;
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
  project: Pick<Project, 'preferredLinter' | 'hasTypeAwareOxlint'>,
  argv: Pick<LintCommandOptions, 'fix' | 'format'> &
    Partial<Pick<LintCommandOptions, 'quiet'>> & { allowAllRules?: boolean },
  files?: string[],
  ignorePatterns: string[] = []
): string | undefined {
  if (project.preferredLinter === 'oxlint') {
    return buildShellCommand([
      'YARN',
      'oxlint',
      '--no-error-on-unmatched-pattern',
      // Type-aware mode makes oxlint report type-check diagnostics. Pass the flags explicitly
      // because oxlint rejects the equivalent options in non-root configs, so per-package runs
      // in monorepos would otherwise miss type errors.
      ...(project.hasTypeAwareOxlint ? ['--type-aware', '--type-check'] : []),
      ...(argv.quiet ? ['--quiet'] : []),
      ...(argv.allowAllRules ? ['-A', 'all'] : []),
      ...(argv.fix ? ['--fix'] : []),
      ...(files ?? ['.']),
      ...ignorePatterns.flatMap((pattern) => ['--ignore-pattern', pattern]),
    ]);
  }
  return;
}

/**
 * Oxlint ignore patterns that keep a workspace root's run out of the workspaces that run the same
 * check themselves, so the root covers exactly the files no workspace covers: its own (e.g.
 * `test/`, `scripts/`, `*.config.ts`) and those of workspaces without the tool.
 */
export function buildWorkspaceIgnorePatterns(
  project: Project,
  projects: Project[],
  checksItself: (workspace: Project) => boolean
): string[] {
  if (!project.packageJson.workspaces) return [];
  return (
    projects
      .filter((workspace) => workspace !== project && checksItself(workspace))
      // The leading slash anchors the pattern to the root: a bare name would match a directory of
      // that name at any depth.
      .map((workspace) => `/${path.relative(project.dirPath, workspace.dirPath)}`)
  );
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
  const targets = toLintTargets(files);
  return [
    buildShellCommand(['poetry', 'run', 'isort', '--profile', 'black', '--filter-files', ...targets]),
    buildShellCommand(['poetry', 'run', 'black', ...targets]),
  ].join(' && ');
}

export function buildPoetryLintCommand(argv: Partial<Pick<LintCommandOptions, 'quiet'>>, files?: string[]): string {
  return buildShellCommand(['poetry', 'run', 'flake8', ...(argv.quiet ? ['-q'] : []), ...toLintTargets(files)]);
}

function buildCargoFormatCommand(): string {
  // Formatting must go through cargo (not rustfmt on individual files) so each
  // crate's edition and rustfmt configuration are respected; `--all` covers
  // every workspace member and is a no-op suffix for single-crate projects.
  return buildShellCommand(['cargo', 'fmt', '--all']);
}

export function buildDartFormatCommand(files?: string[]): string {
  return buildShellCommand(['dart', 'format', ...toLintTargets(files)]);
}

export function buildDartLintCommand(files?: string[]): string {
  return buildShellCommand(['dart', 'analyze', ...toLintTargets(files)]);
}

function toLintTargets(files: string[] | undefined): string[] {
  return files && files.length > 0 ? files : ['.'];
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
