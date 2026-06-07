import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import chalk from 'chalk';
import { globby } from 'globby';
import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects, getFileDatabaseUrlPath, type Project } from '../project.js';
import { packageManager } from '../utils/runtime.js';

import { prepareForRunningCommand } from './commandUtils.js';

const dependencySectionKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const sqliteFilePattern = /\.(?:sqlite3?|db)(?:[-.](?:journal|shm|wal))?$/i;
const dockerBuildCachePaths = [
  '.cache',
  '.mypy_cache',
  '.next/cache',
  '.parcel-cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.turbo',
  '.venv',
  '.yarn/cache',
  '.yarn/install-state.gz',
  '__pycache__',
  'coverage',
  'node_modules/.cache',
  'playwright-report',
  'storybook-static',
  'target',
  'test-results',
];
const dockerBuildCachePatterns = ['**/*.pyc', '**/*.tsbuildinfo', '**/__pycache__'];
const generatedSqliteDirNames = ['prisma', 'db', 'drizzle'] as const;
const dockerGeneratedDataDirPaths = ['/data'] as const;

const builder = {
  outside: {
    description: 'Whether the optimization is executed outside a docker container or not',
    type: 'boolean',
    alias: 'o',
  },
} as const;

export const optimizeForDockerBuildCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'optimizeForDockerBuild',
  describe: 'Optimize configuration when building a Docker image',
  builder,
  async handler(argv) {
    const projects = await findDescendantProjects(argv);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const optimizedProjects: Project[] = [];
    for (const project of prepareForRunningCommand('optimizeForDockerBuild', projects.descendants)) {
      const packageJson: PackageJson = project.packageJson;
      rewritePrivateGitHubDependencies(project, packageJson);
      const removedDevDependencies = optimizeDevDependencies(argv, packageJson);

      optimizeScripts(packageJson, {
        removeWbPostinstall: !argv.outside && removedDevDependencies.includes('@willbooster/wb'),
      });

      optimizeRootProps(packageJson);

      if (argv.dryRun) continue;

      const distDirPath = argv.outside ? path.join(project.dirPath, 'dist') : project.dirPath;
      await fs.promises.mkdir(distDirPath, { recursive: true });
      await fs.promises.writeFile(path.join(distDirPath, 'package.json'), JSON.stringify(packageJson), 'utf8');
      if (argv.outside) {
        await writeDockerShellScripts(path.join(distDirPath, 'bash'));
      }
      optimizedProjects.push(project);
    }
    if (!argv.dryRun && !argv.outside) {
      child_process.spawnSync(packageManager, ['install'], {
        stdio: 'inherit',
      });
      console.info('Installed dependencies.');
      await cleanupDockerBuildArtifacts(optimizedProjects);
    }
  },
};

function rewritePrivateGitHubDependencies(project: Project, packageJson: PackageJson): string[] {
  return rewritePrivateGitHubDependenciesForDir(project.rootDirPath, project.dirPath, packageJson);
}

function rewritePrivateGitHubDependenciesForDir(
  rootDirPath: string,
  packageDirPath: string,
  packageJson: PackageJson
): string[] {
  const rewrittenDependencies: string[] = [];
  for (const key of dependencySectionKeys) {
    const deps = packageJson[key] ?? {};
    for (const [name, value] of Object.entries(deps)) {
      if (value?.startsWith('git@github.com:')) {
        // Docker builds cannot access private SSH URLs unless credentials are forwarded.
        // The Dockerfile copies those workspace packages into the image instead.
        deps[name] = getPrivatePackageDockerSpecifier(rootDirPath, packageDirPath, name);
        rewrittenDependencies.push(`${key}.${name}`);
      }
    }
  }
  console.info('Rewrote private GitHub dependencies:', rewrittenDependencies.join(', ') || 'none');
  return rewrittenDependencies;
}

function getPrivatePackageDockerSpecifier(rootDirPath: string, packageDirPath: string, packageName: string): string {
  const privatePackageDirPath = path.join(rootDirPath, '@willbooster', toUnscopedPackageName(packageName));
  const relativePath = path.relative(packageDirPath, privatePackageDirPath);
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function toUnscopedPackageName(packageName: string): string {
  return packageName.replace(/^@willbooster\//, '');
}

async function writeDockerShellScripts(dirPath: string): Promise<void> {
  const sourceDirPath = findDockerShellScriptsDirPath();
  await fs.promises.mkdir(dirPath, { recursive: true });
  for (const dirent of await fs.promises.readdir(sourceDirPath, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith('.sh')) continue;

    const targetFilePath = path.join(dirPath, dirent.name);
    await fs.promises.copyFile(path.join(sourceDirPath, dirent.name), targetFilePath);
    await fs.promises.chmod(targetFilePath, 0o755);
  }
  console.info(`Generated Docker shell scripts: ${path.relative(process.cwd(), dirPath) || dirPath}`);
}

function findDockerShellScriptsDirPath(): string {
  let currentDirPath = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(currentDirPath, 'docker', 'bash');
    if (fs.existsSync(candidate)) return candidate;

    const parentDirPath = path.dirname(currentDirPath);
    if (parentDirPath === currentDirPath) {
      throw new Error('Docker shell scripts directory not found.');
    }
    currentDirPath = parentDirPath;
  }
}

function optimizeDevDependencies(argv: InferredOptionTypes<typeof builder>, packageJson: PackageJson): string[] {
  if (argv.outside) {
    // Outside optimization writes dist/package.json before Docker builds the app.
    // Keep build-time dependencies and remove only known non-build tooling.
    return removeUnnecessaryDevDependenciesForOutsideDockerBuild(packageJson);
  }

  // Inside Docker, codegen/build has already finished, so production install should not see dev tooling.
  const removedDependencies = Object.keys(packageJson.devDependencies ?? {});
  delete packageJson.devDependencies;
  console.info('Removed all devDependencies.');
  return removedDependencies;
}

function removeUnnecessaryDevDependenciesForOutsideDockerBuild(packageJson: PackageJson): string[] {
  const devDeps = packageJson.devDependencies ?? {};
  // In --outside mode, Docker still runs codegen/build before a second in-image optimization.
  // Remove only tooling that is not needed for that build phase.
  const nameWordsToBeRemoved = [
    'artillery',
    'biome',
    'concurrently',
    'conventional-changelog-conventionalcommits',
    'eslint',
    'husky',
    'imagemin',
    'jest',
    'kill-port',
    'lint-staged',
    'open-cli',
    'oxfmt',
    'oxlint',
    'playwright',
    'prettier',
    'pinst',
    'railway',
    'semantic-release',
    'sort-package-json',
    'wait-on',
    'vitest',
  ];
  const removedDeps: string[] = [];
  for (const name of Object.keys(devDeps)) {
    if (
      nameWordsToBeRemoved.some((word) => name.includes(word)) ||
      // Shared config packages are needed only for lint/format/test commands, not Docker builds.
      (name.includes('willbooster') && name.includes('config'))
    ) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete devDeps[name];
      removedDeps.push(name);
    }
  }
  console.info('Removed devDependencies:', removedDeps.join(', ') || 'none');
  return removedDeps;
}

function optimizeScripts(packageJson: PackageJson, options: { removeWbPostinstall: boolean }): void {
  const nameWordsOfUnnecessaryScripts = ['check', 'deploy', 'format', 'lint', 'start', 'test'];
  const contentWordsOfUnnecessaryScripts = ['pinst ', 'husky '];
  const scripts = (packageJson.scripts ?? {}) as Record<string, string>;
  const removedScripts: string[] = [];
  for (const [name, content] of Object.entries(scripts)) {
    if (
      (options.removeWbPostinstall && name === 'postinstall' && content.trim() === 'wb gen-code') ||
      nameWordsOfUnnecessaryScripts.some((word) => name.startsWith(word)) ||
      // Support "husky" since husky v9 requires `"postinstall": "husky"`
      contentWordsOfUnnecessaryScripts.some((word) => content.includes(word) || content.trim() === word.trim())
    ) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete scripts[name];
      removedScripts.push(name);
    }
  }
  console.info('Removed scripts:', removedScripts.join(', ') || 'none');
}

function optimizeRootProps(packageJson: PackageJson): void {
  delete packageJson.private;
  delete packageJson.publishConfig;
  delete packageJson.prettier;
}

async function cleanupDockerBuildArtifacts(projects: Project[]): Promise<void> {
  for (const project of projects) {
    await removeProjectCaches(project);
    await removeGeneratedLocalData(project);
    runDockerCleanupScript(project);
  }
}

async function removeProjectCaches(project: Project): Promise<void> {
  const relativePaths = [
    ...(await removeDockerBuildCachePaths(project)),
    ...(await removeDockerBuildCachePatterns(project)),
  ];
  console.info('Removed Docker build caches:', relativePaths.join(', ') || 'none');
}

async function removeDockerBuildCachePaths(project: Project): Promise<string[]> {
  const removedPaths: string[] = [];
  for (const relativePath of dockerBuildCachePaths) {
    const targetPath = path.join(project.dirPath, relativePath);
    if (!fs.existsSync(targetPath)) continue;

    await fs.promises.rm(targetPath, { force: true, recursive: true });
    removedPaths.push(relativePath);
  }
  return removedPaths;
}

async function removeDockerBuildCachePatterns(project: Project): Promise<string[]> {
  const relativePaths = await globby(dockerBuildCachePatterns, {
    cwd: project.dirPath,
    dot: true,
    followSymbolicLinks: false,
    ignore: ['**/node_modules', '**/node_modules/**', '**/.yarn', '**/.yarn/**', '**/.git', '**/.git/**'],
    onlyFiles: false,
  });
  await Promise.all(
    relativePaths.map((relativePath) =>
      fs.promises.rm(path.join(project.dirPath, relativePath), { force: true, recursive: true })
    )
  );
  return relativePaths;
}

async function removeGeneratedLocalData(project: Project): Promise<void> {
  const removedPathGroups = await Promise.all([removeGeneratedMountDirs(project), removeGeneratedSqliteFiles(project)]);
  const removedPaths = removedPathGroups.flat();
  console.info('Removed generated local data:', removedPaths.join(', ') || 'none');
}

async function removeGeneratedMountDirs(project: Project): Promise<string[]> {
  const relativePaths = getGeneratedMountDirPaths(project);
  const removedPaths: string[] = [];
  for (const relativePath of relativePaths) {
    const targetPath = path.join(project.dirPath, relativePath);
    if (!fs.existsSync(targetPath)) continue;

    await fs.promises.rm(targetPath, { force: true, recursive: true });
    removedPaths.push(relativePath);
  }
  return removedPaths;
}

function getGeneratedMountDirPaths(project: Project): string[] {
  const defaultPaths = generatedSqliteDirNames.map((dirName) => path.join(dirName, 'mount'));
  const dbPath = project.env.DATABASE_PATH ?? getFileDatabaseUrlPath(project);
  if (!dbPath) return defaultPaths;

  const absoluteDirPath = path.dirname(path.isAbsolute(dbPath) ? dbPath : path.resolve(project.dirPath, dbPath));
  if (path.basename(absoluteDirPath) !== 'mount' || !isPathInsideProject(project, absoluteDirPath)) {
    return defaultPaths;
  }
  const relativePath = path.relative(project.dirPath, absoluteDirPath);
  if (!relativePath) return defaultPaths;

  return [...new Set([...defaultPaths, relativePath])];
}

async function removeGeneratedSqliteFiles(project: Project): Promise<string[]> {
  const removedPaths = await Promise.all([
    removeGeneratedSqliteFilesInDefaultDirs(project),
    removeEnvGeneratedSqliteFiles(project),
  ]);
  return removedPaths.flat();
}

async function removeGeneratedSqliteFilesInDefaultDirs(project: Project): Promise<string[]> {
  const dirPaths = await getGeneratedSqliteDirPaths(project);
  const removedPaths = await Promise.all(dirPaths.map((dirPath) => removeGeneratedSqliteFilesInDir(project, dirPath)));
  return removedPaths.flat();
}

async function getGeneratedSqliteDirPaths(project: Project): Promise<string[]> {
  const dirPaths = generatedSqliteDirNames.map((dirName) => path.join(project.dirPath, dirName));
  const results = await Promise.all(dirPaths.map((dirPath) => isDirectory(dirPath)));
  return dirPaths.filter((_, index) => results[index]);
}

async function removeEnvGeneratedSqliteFiles(project: Project): Promise<string[]> {
  const dbFilePaths = getEnvGeneratedSqliteFilePaths(project);
  const removedPaths: string[] = [];
  for (const dbFilePath of dbFilePaths) {
    for (const targetPath of getSqliteFileFamilyPaths(dbFilePath)) {
      if (!(await isFile(targetPath))) continue;

      await fs.promises.rm(targetPath, { force: true });
      removedPaths.push(path.relative(project.dirPath, targetPath));
    }
  }
  return removedPaths;
}

function getEnvGeneratedSqliteFilePaths(project: Project): string[] {
  const dbPath = project.env.DATABASE_PATH ?? getFileDatabaseUrlPath(project);
  if (!dbPath) return [];

  const filePaths = path.isAbsolute(dbPath)
    ? [dbPath]
    : [
        path.resolve(project.dirPath, dbPath),
        ...generatedSqliteDirNames.map((dirName) => path.resolve(project.dirPath, dirName, dbPath)),
      ];
  return [...new Set(filePaths)].filter((filePath) => isGeneratedSqliteFilePathSafe(project, filePath));
}

function isGeneratedSqliteFilePathSafe(project: Project, filePath: string): boolean {
  return isPathInsideProject(project, filePath) || isDockerGeneratedDataFilePath(project, filePath);
}

function isDockerGeneratedDataFilePath(project: Project, filePath: string): boolean {
  if (!isDockerEnabled(project)) return false;

  return dockerGeneratedDataDirPaths.some((dirPath) => {
    const relativePath = path.relative(dirPath, filePath);
    return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith('../');
  });
}

function getSqliteFileFamilyPaths(dbFilePath: string): string[] {
  return [
    dbFilePath,
    `${dbFilePath}-journal`,
    `${dbFilePath}-shm`,
    `${dbFilePath}-wal`,
    `${dbFilePath}.journal`,
    `${dbFilePath}.shm`,
    `${dbFilePath}.wal`,
  ];
}

function isPathInsideProject(project: Project, targetPath: string): boolean {
  const relativePath = path.relative(project.dirPath, targetPath);
  // `startsWith('..')` would reject project-local names such as `..cache`.
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`));
}

function isDockerEnabled(project: Project): boolean {
  return !!project.env.WB_DOCKER && project.env.WB_DOCKER !== '0' && project.env.WB_DOCKER !== 'false';
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function removeGeneratedSqliteFilesInDir(project: Project, dirPath: string): Promise<string[]> {
  const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const sqliteFileNames = dirents
    .filter((dirent) => dirent.isFile() && sqliteFilePattern.test(dirent.name))
    .map((dirent) => dirent.name);
  await Promise.all(sqliteFileNames.map((fileName) => fs.promises.rm(path.join(dirPath, fileName), { force: true })));

  const relativeDirPath = path.relative(project.dirPath, dirPath);
  return sqliteFileNames.map((fileName) => path.join(relativeDirPath, fileName));
}

function runDockerCleanupScript(project: Project): void {
  if (!isDockerEnabled(project)) return;

  const scriptPath = path.join(project.dirPath, 'bash', 'cleanup.sh');
  if (!fs.existsSync(scriptPath)) return;

  const result = child_process.spawnSync('bash', [scriptPath, '--keep-scripts'], {
    cwd: project.dirPath,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to run ${path.relative(project.dirPath, scriptPath)}`);
  }
}
