import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import chalk from 'chalk';
import { globby } from 'globby';
import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects, type Project } from '../project.js';
import { packageManager } from '../utils/runtime.js';

import { prepareForRunningCommand } from './commandUtils.js';

const dependencySectionKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const localPackageCopyIgnoredDirNames = new Set(['.git', '.tmp', 'node_modules']);

interface DockerLockfileRequest {
  dependenciesChanged: boolean;
  distDirPath: string;
  packageJson: PackageJson;
  project: Project;
}

interface LockfileWorkspace {
  installDirPath: string;
  rootDirPath: string;
}

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

    const dockerLockfileRequests: DockerLockfileRequest[] = [];
    for (const project of prepareForRunningCommand('optimizeForDockerBuild', projects.descendants)) {
      const packageJson: PackageJson = project.packageJson;
      const rewrittenDependencies = rewritePrivateGitHubDependencies(project, packageJson);
      const prunedDependencies = optimizeDevDependencies(argv, packageJson);
      const dependenciesChanged = prunedDependencies.length > 0 || rewrittenDependencies.length > 0;

      optimizeScripts(packageJson);

      optimizeRootProps(packageJson);

      if (argv.dryRun) continue;

      const distDirPath = argv.outside ? path.join(project.dirPath, 'dist') : project.dirPath;
      await fs.promises.mkdir(distDirPath, { recursive: true });
      await fs.promises.writeFile(path.join(distDirPath, 'package.json'), JSON.stringify(packageJson), 'utf8');
      if (argv.outside) {
        await writeDockerShellScripts(path.join(distDirPath, 'bash'));
        dockerLockfileRequests.push({ dependenciesChanged, distDirPath, packageJson, project });
      }
    }
    const changedRootDirPaths = new Set(
      dockerLockfileRequests
        .filter((request) => request.dependenciesChanged)
        .map((request) => request.project.rootDirPath)
    );
    for (const request of dockerLockfileRequests) {
      const writeLockfile =
        request.dependenciesChanged || changedRootDirPaths.has(request.project.dirPath)
          ? writePrunedLockfile
          : copySourceLockfile;
      await writeLockfile(request.project, request.packageJson, request.distDirPath);
    }
    if (!argv.dryRun && !argv.outside) {
      child_process.spawnSync(packageManager, ['install'], {
        stdio: 'inherit',
      });
      console.info('Installed dependencies.');
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
    'concurrently',
    'conventional-changelog-conventionalcommits',
    'husky',
    'imagemin',
    'jest',
    'kill-port',
    'lint-staged',
    'open-cli',
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

async function writePrunedLockfile(project: Project, packageJson: PackageJson, distDirPath: string): Promise<void> {
  const lockfileWriter = project.usesBunPackageManager ? writePrunedBunLockfile : writePrunedYarnLockfile;
  await lockfileWriter(project, packageJson, distDirPath);
}

async function copySourceLockfile(project: Project, _packageJson: PackageJson, distDirPath: string): Promise<void> {
  const sourceLockfilePath = project.usesBunPackageManager
    ? findFirstExistingProjectFile(project, ['bun.lock', 'bun.lockb'])
    : findFirstExistingProjectFile(project, ['yarn.lock']);
  if (!sourceLockfilePath) return;

  const targetLockfilePath = path.join(distDirPath, path.basename(sourceLockfilePath));
  await fs.promises.copyFile(sourceLockfilePath, targetLockfilePath);
  console.info(`Copied Docker lockfile: ${path.relative(process.cwd(), targetLockfilePath)}`);
}

async function writePrunedBunLockfile(project: Project, packageJson: PackageJson, distDirPath: string): Promise<void> {
  const sourceLockfilePath = findFirstExistingProjectFile(project, ['bun.lock', 'bun.lockb']);
  if (!sourceLockfilePath) {
    console.info('Skipped pruned Bun lockfile generation because no Bun lockfile was found.');
    return;
  }

  const workspace = await prepareLockfileWorkspace(project, packageJson, [
    path.basename(sourceLockfilePath),
    'bunfig.toml',
  ]);
  try {
    const result = child_process.spawnSync('bun', ['install', '--lockfile-only'], {
      cwd: workspace.installDirPath,
      stdio: 'inherit',
    });
    throwIfCommandFailed(result, 'bun install --lockfile-only');

    const generatedLockfilePath = findFirstExistingFile(workspace.rootDirPath, ['bun.lock', 'bun.lockb']);
    if (!generatedLockfilePath) throw new Error('bun install --lockfile-only did not generate a lockfile.');

    const targetLockfilePath = path.join(distDirPath, path.basename(generatedLockfilePath));
    await fs.promises.copyFile(generatedLockfilePath, targetLockfilePath);
    console.info(`Generated pruned Bun lockfile: ${path.relative(process.cwd(), targetLockfilePath)}`);
  } finally {
    await fs.promises.rm(workspace.rootDirPath, { recursive: true, force: true });
  }
}

async function writePrunedYarnLockfile(project: Project, packageJson: PackageJson, distDirPath: string): Promise<void> {
  const sourceLockfilePath = findFirstExistingProjectFile(project, ['yarn.lock']);
  if (!sourceLockfilePath) {
    console.info('Skipped pruned Yarn lockfile generation because no yarn.lock was found.');
    return;
  }

  const workspace = await prepareLockfileWorkspace(project, packageJson, ['yarn.lock', '.yarnrc.yml', '.yarn']);
  try {
    const result = child_process.spawnSync('yarn', ['install', '--mode=update-lockfile'], {
      cwd: workspace.installDirPath,
      stdio: 'inherit',
    });
    throwIfCommandFailed(result, 'yarn install --mode=update-lockfile');

    const targetLockfilePath = path.join(distDirPath, 'yarn.lock');
    await fs.promises.copyFile(path.join(workspace.rootDirPath, 'yarn.lock'), targetLockfilePath);
    console.info(`Generated pruned Yarn lockfile: ${path.relative(process.cwd(), targetLockfilePath)}`);
  } finally {
    await fs.promises.rm(workspace.rootDirPath, { recursive: true, force: true });
  }
}

async function prepareLockfileWorkspace(
  project: Project,
  packageJson: PackageJson,
  packageManagerFiles: string[]
): Promise<LockfileWorkspace> {
  const tempDirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wb-docker-lock-'));
  try {
    const relativeProjectDirPath = path.relative(project.rootDirPath, project.dirPath);
    const tempProjectDirPath = path.resolve(tempDirPath, relativeProjectDirPath);

    await copyRootPackageJson(project, tempDirPath);
    await fs.promises.mkdir(tempProjectDirPath, { recursive: true });
    await fs.promises.writeFile(path.join(tempProjectDirPath, 'package.json'), JSON.stringify(packageJson), 'utf8');

    for (const fileName of packageManagerFiles) {
      const sourcePath = path.join(project.rootDirPath, fileName);
      if (!fs.existsSync(sourcePath)) continue;

      const targetPath = path.join(tempDirPath, fileName);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.cp(sourcePath, targetPath, { recursive: true });
    }

    await copyLocalPackageReferences(project, packageJson, tempProjectDirPath, tempDirPath);
    await copyWorkspacePackageReferences(project, packageJson, tempDirPath);
    return { installDirPath: tempProjectDirPath, rootDirPath: tempDirPath };
  } catch (error) {
    await fs.promises.rm(tempDirPath, { recursive: true, force: true });
    throw error;
  }
}

async function copyRootPackageJson(project: Project, tempDirPath: string): Promise<void> {
  const optimizedPackageJsonPath = path.join(project.rootDirPath, 'dist', 'package.json');
  const sourcePackageJsonPath = fs.existsSync(optimizedPackageJsonPath)
    ? optimizedPackageJsonPath
    : path.join(project.rootDirPath, 'package.json');
  if (!fs.existsSync(sourcePackageJsonPath)) return;

  if (sourcePackageJsonPath === optimizedPackageJsonPath) {
    await fs.promises.copyFile(sourcePackageJsonPath, path.join(tempDirPath, 'package.json'));
    return;
  }

  const rootPackageJson = JSON.parse(await fs.promises.readFile(sourcePackageJsonPath, 'utf8')) as PackageJson;
  rewritePrivateGitHubDependenciesForDir(project.rootDirPath, project.rootDirPath, rootPackageJson);
  removeUnnecessaryDevDependenciesForOutsideDockerBuild(rootPackageJson);
  await fs.promises.writeFile(path.join(tempDirPath, 'package.json'), JSON.stringify(rootPackageJson), 'utf8');
}

async function copyLocalPackageReferences(
  project: Project,
  packageJson: PackageJson,
  tempProjectDirPath: string,
  tempRootDirPath: string
): Promise<void> {
  for (const dependencies of dependencySectionKeys.map((sectionKey) => packageJson[sectionKey] ?? {})) {
    for (const dependencySpecifier of Object.values(dependencies)) {
      const relativePackagePath = getLocalPackageRelativePath(dependencySpecifier);
      if (!relativePackagePath) continue;

      await copyLocalPackageDirectory(
        path.resolve(project.dirPath, relativePackagePath),
        getSafeTempPackagePath(tempRootDirPath, tempProjectDirPath, relativePackagePath)
      );
    }
  }
}

async function copyWorkspacePackageReferences(
  project: Project,
  packageJson: PackageJson,
  tempDirPath: string
): Promise<void> {
  const workspacePatterns = getWorkspacePatterns(getRootPackageJson(project) ?? packageJson);
  if (workspacePatterns.length === 0) return;

  const workspacePackageJsonPaths = await globby(
    workspacePatterns.map((pattern) => `${pattern.replace(/\/$/, '')}/package.json`),
    { cwd: project.rootDirPath, onlyFiles: true }
  );
  for (const packageJsonPath of workspacePackageJsonPaths) {
    const relativePackageDirPath = path.dirname(packageJsonPath);
    await copyLocalPackageDirectory(
      path.resolve(project.rootDirPath, relativePackageDirPath),
      path.resolve(tempDirPath, relativePackageDirPath)
    );
    await copyOptimizedWorkspacePackageJson(project, relativePackageDirPath, tempDirPath);
  }
}

async function copyOptimizedWorkspacePackageJson(
  project: Project,
  relativePackageDirPath: string,
  tempDirPath: string
): Promise<void> {
  const optimizedPackageJsonPath = path.resolve(project.rootDirPath, relativePackageDirPath, 'dist/package.json');
  if (!fs.existsSync(optimizedPackageJsonPath)) return;

  await fs.promises.copyFile(
    optimizedPackageJsonPath,
    path.resolve(tempDirPath, relativePackageDirPath, 'package.json')
  );
}

async function copyLocalPackageDirectory(sourceDirPath: string, targetDirPath: string): Promise<void> {
  if (!fs.existsSync(sourceDirPath)) {
    throw new Error(`Local package directory not found: ${sourceDirPath}`);
  }
  if (fs.existsSync(targetDirPath)) return;

  await fs.promises.mkdir(path.dirname(targetDirPath), { recursive: true });
  await fs.promises.cp(sourceDirPath, targetDirPath, {
    recursive: true,
    filter: (sourcePath) => shouldCopyLocalPackagePath(sourceDirPath, sourcePath),
  });
}

function shouldCopyLocalPackagePath(sourceDirPath: string, sourcePath: string): boolean {
  const relativePath = path.relative(sourceDirPath, sourcePath);
  if (!relativePath) return true;

  return !relativePath.split(path.sep).some((part) => localPackageCopyIgnoredDirNames.has(part));
}

function getSafeTempPackagePath(
  tempRootDirPath: string,
  tempProjectDirPath: string,
  relativePackagePath: string
): string {
  const targetDirPath = path.resolve(tempProjectDirPath, relativePackagePath);
  if (targetDirPath !== tempRootDirPath && !targetDirPath.startsWith(`${tempRootDirPath}${path.sep}`)) {
    throw new Error(`Local package path escapes the temporary lockfile workspace: ${relativePackagePath}`);
  }
  return targetDirPath;
}

function getWorkspacePatterns(packageJson: PackageJson): string[] {
  if (Array.isArray(packageJson.workspaces)) return packageJson.workspaces;
  if (Array.isArray(packageJson.workspaces?.packages)) return packageJson.workspaces.packages;
  return [];
}

function getLocalPackageRelativePath(dependencySpecifier: string | undefined): string | undefined {
  if (!dependencySpecifier) return;

  const specifier = dependencySpecifier.startsWith('file:')
    ? dependencySpecifier.slice('file:'.length)
    : dependencySpecifier;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return;

  return specifier;
}

function findFirstExistingFile(dirPath: string, fileNames: string[]): string | undefined {
  for (const fileName of fileNames) {
    const filePath = path.join(dirPath, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }
  return undefined;
}

function findFirstExistingProjectFile(project: Project, fileNames: string[]): string | undefined {
  for (const fileName of fileNames) {
    const filePath = path.join(project.rootDirPath, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }
  return undefined;
}

function getRootPackageJson(project: Project): PackageJson | undefined {
  const packageJsonPath = path.join(project.rootDirPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return undefined;

  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
}

function throwIfCommandFailed(result: child_process.SpawnSyncReturns<Buffer>, command: string): void {
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function optimizeScripts(packageJson: PackageJson): void {
  const nameWordsOfUnnecessaryScripts = ['check', 'deploy', 'format', 'lint', 'start', 'test'];
  const contentWordsOfUnnecessaryScripts = ['pinst ', 'husky '];
  const scripts = (packageJson.scripts ?? {}) as Record<string, string>;
  const removedScripts: string[] = [];
  for (const [name, content] of Object.entries(scripts)) {
    if (
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
