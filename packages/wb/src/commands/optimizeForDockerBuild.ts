import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import chalk from 'chalk';
import { globby } from 'globby';
import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import {
  findDescendantProjects,
  findSelfProject,
  getAbsoluteFileDatabaseUrlPath,
  getFileDatabaseUrlPath,
  type Project,
} from '../project.js';
import { isCI, isDockerEnabled } from '../utils/ci.js';
import { lintDockerfile } from '../utils/dockerfileLint.js';

import {
  PRIVATE_REGISTRY_SCOPE,
  isPrivateGitDependency,
  isPrivateRegistryDependency,
  materializedVersionSatisfies,
  toUnscopedPackageName,
} from '../utils/privateRegistry.js';

import { prepareForRunningCommand } from './commandUtils.js';
import { type GenDockerEnvCommandArgv, generateDockerEnv } from './genDockerEnv.js';
import { collectManifests, materializePrivatePackages } from './setupPrivatePackages.js';

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

    // Materialize private dependencies on the host first so the per-project rewrite below resolves
    // them to file: paths and the Docker build needs no registry credentials. Only in --outside
    // mode (the in-image second pass has no node_modules/registry to materialize from) and only
    // when a private dependency is actually declared, so repos without one are untouched — no empty
    // output directories, no spurious "COPY" hint. Failures are non-fatal and non-destructive:
    // materialize throws before deleting any existing output (and cleans up its staging on a failed
    // download), so a repo lacking registry credentials keeps building exactly as before, with the
    // per-project rewrite below emitting the existing "run wb setup-private-packages" hint. This
    // keeps the step a pure convenience that lets repositories drop the explicit command.
    if (argv.outside) {
      prepareDockerBuildInputs(argv as GenDockerEnvCommandArgv & typeof argv, projects);
      // Resolve the full workspace set from the repository root so a private dependency declared in
      // any sibling workspace is materialized even when optimize runs from a subpackage directory.
      const rootProjects = await findDescendantProjects(argv, false, projects.root.dirPath);
      const manifests = collectManifests(rootProjects ?? projects);
      if (manifests.some(declaresPrivateDependency)) {
        try {
          await materializePrivatePackages(projects.root.dirPath, manifests, { dryRun: Boolean(argv.dryRun) });
        } catch (error) {
          console.warn(
            chalk.yellow(
              `Could not auto-materialize private packages (${error instanceof Error ? error.message : String(error)}); ` +
                'run `wb setup-private-packages` if the Docker build needs them. Continuing.'
            )
          );
        }
      }
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
      child_process.spawnSync(projects.root.packageManagerCommand, ['install'], {
        stdio: 'inherit',
      });
      console.info('Installed dependencies.');
      await cleanupDockerBuildArtifacts(optimizedProjects);
    }
  },
};

/**
 * Lints the Dockerfile and generates the non-secret `.docker.env` before an outside optimization
 * pass, i.e. before every Docker build (wb's docker flows and deploy scripts all run
 * `optimizeForDockerBuild --outside` first).
 */
function prepareDockerBuildInputs(argv: GenDockerEnvCommandArgv, projects: { root: Project; self: Project }): void {
  // Resolve the Dockerfile the same way the build does: the self project's own Dockerfile wins
  // over the repository root's, so workspace-level Dockerfiles are linted too.
  const candidateDirPaths = [...new Set([projects.self.dirPath, projects.root.dirPath])];
  const dockerfileDirPath = candidateDirPaths.find((dirPath) => fs.existsSync(path.join(dirPath, 'Dockerfile')));
  const dockerfileText = dockerfileDirPath
    ? fs.readFileSync(path.join(dockerfileDirPath, 'Dockerfile'), 'utf8')
    : undefined;
  // The escape hatch is read WITHOUT loading the project environment (loading would spawn
  // `fnox export`, i.e. decrypt every secret, and hard-fail keyless CI runs), so it must be
  // exported in the build environment rather than declared in fnox.toml.
  const skipLint = findSelfProject(argv, false)?.env.WB_SKIP_DOCKERFILE_LINT === '1';
  if (dockerfileText && !skipLint) {
    // Plain BuildKit (local builds, CI) accepts these problems silently, so without this check
    // they are first detected by a failed production deploy. WB_SKIP_DOCKERFILE_LINT=1 is the
    // escape hatch for repositories that keep a Railway config but build their image elsewhere.
    // `.railwayignore` is deliberately NOT a signal: wbfy creates it for any Railway-related
    // repository (including ones whose image is built elsewhere), so using it here would turn
    // the lint on circularly.
    const railwayConfigured = candidateDirPaths.some((dirPath) =>
      ['railway.toml', 'railway.json'].some((name) => fs.existsSync(path.join(dirPath, name)))
    );
    const problems = lintDockerfile(dockerfileText, { railwayConfigured });
    if (problems.length > 0) {
      throw new Error(`Dockerfile problems:\n- ${problems.join('\n- ')}`);
    }
  }

  const dockerfileConsumesDockerEnv = (dockerfileText ?? '')
    .split('\n')
    .some((line) => !/^\s*#/u.test(line) && line.includes('.docker.env'));
  if (
    dockerfileConsumesDockerEnv &&
    candidateDirPaths.some((dirPath) => fs.existsSync(path.join(dirPath, 'fnox.toml')))
  ) {
    // Mirror Project.completeAndValidateWbEnv WITHOUT loading fnox: generateDockerEnv resolves
    // the profile via the cascade, which silently falls back to development when CI forgets to
    // export WB_ENV — that must fail the build, not bake a development-profile image.
    const processEnvView = findSelfProject(argv, false)?.env ?? {};
    if (
      isCI(processEnvView.CI) &&
      !processEnvView.WB_ENV &&
      // An explicit cascade flag selects the profile just as well as an exported WB_ENV; only
      // the implicit development fallback must fail.
      !argv.cascadeEnv &&
      !(argv.cascadeNodeEnv && processEnvView.NODE_ENV) &&
      // Match Project.completeAndValidateWbEnv's opt-out values exactly.
      processEnvView.WB_SKIP_ENV_CHECK !== '1' &&
      processEnvView.WB_SKIP_ENV_CHECK !== 'true'
    ) {
      throw new Error(
        'WB_ENV is not exported on CI; export it before building the image so .docker.env bakes the right profile (or set WB_SKIP_ENV_CHECK=1).'
      );
    }
    generateDockerEnv({ ...argv, path: undefined });
  }
}

/** Whether any dependency section declares a private git or `@willbooster-private/*` registry dependency. */
function declaresPrivateDependency(packageJson: PackageJson): boolean {
  return dependencySectionKeys.some((key) => {
    const deps = packageJson[key];
    return (
      deps !== undefined &&
      Object.entries(deps).some(
        ([name, value]) => isPrivateGitDependency(value) || isPrivateRegistryDependency(name, value)
      )
    );
  });
}

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
      if (isPrivateGitDependency(value)) {
        // Docker builds cannot access private SSH URLs unless credentials are forwarded.
        // The Dockerfile copies those workspace packages into the image instead. Only the org's
        // own git dependencies are rewritten — the shared predicate matches exactly what
        // `wb setup-private-packages` materializes, so other SSH URLs are left unchanged instead
        // of being pointed at never-materialized local paths.
        deps[name] = getPrivatePackageDockerSpecifier(rootDirPath, packageDirPath, '@willbooster', name);
        rewrittenDependencies.push(`${key}.${name}`);
      } else if (isPrivateRegistryDependency(name, value)) {
        const materializedVersion = readMaterializedPackageVersion(rootDirPath, name);
        if (materializedVersion === undefined) {
          // Leaving the registry specifier means the in-image install needs Verdaccio
          // credentials — the failure this feature exists to avoid — so say so out loud.
          console.warn(
            chalk.yellow(
              `${name} is not materialized under ${PRIVATE_REGISTRY_SCOPE}/; run \`wb setup-private-packages\` so the Docker build does not need registry credentials.`
            )
          );
          continue;
        }
        // The materialized version is stale when the specifier (an exact version or any semver
        // range `wb setup-private-packages` resolves max-satisfying against the registry) does
        // not admit it. Dist-tag specifiers (e.g. `2026-stable`) skip the staleness check.
        if (!materializedVersionSatisfies(value, materializedVersion)) {
          console.error(
            chalk.red(
              `Materialized ${name} is ${materializedVersion} but package.json requires ${value}; rerun \`wb setup-private-packages\`.`
            )
          );
          process.exit(1);
        }
        // Registry packages that `wb setup-private-packages` materialized on the host are used as
        // local paths so image builds need no Verdaccio credentials; the COMMITTED package.json
        // keeps the registry specifier — only the generated (dist/)package.json is rewritten
        // (https://github.com/WillBooster/shared/issues/964).
        deps[name] = getPrivatePackageDockerSpecifier(rootDirPath, packageDirPath, PRIVATE_REGISTRY_SCOPE, name);
        rewrittenDependencies.push(`${key}.${name}`);
      }
    }
  }
  console.info('Rewrote private dependencies:', rewrittenDependencies.join(', ') || 'none');
  return rewrittenDependencies;
}

function getPrivatePackageDockerSpecifier(
  rootDirPath: string,
  packageDirPath: string,
  scopeDirName: string,
  packageName: string
): string {
  const privatePackageDirPath = path.join(rootDirPath, scopeDirName, toUnscopedPackageName(packageName));
  const relativePath = path.relative(packageDirPath, privatePackageDirPath);
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

/** Undefined when the package is not materialized (or its manifest is unreadable/versionless). */
function readMaterializedPackageVersion(rootDirPath: string, packageName: string): string | undefined {
  const packageJsonPath = path.join(
    rootDirPath,
    PRIVATE_REGISTRY_SCOPE,
    toUnscopedPackageName(packageName),
    'package.json'
  );
  try {
    return (JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson).version;
  } catch {
    return undefined;
  }
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
  const dbPath = getAbsoluteFileDatabaseUrlPath(project);
  if (!dbPath) return defaultPaths;

  const absoluteDirPath = path.dirname(dbPath);
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
  const dbPath = getFileDatabaseUrlPath(project);
  const absoluteDbPath = getAbsoluteFileDatabaseUrlPath(project);
  if (!dbPath || !absoluteDbPath) return [];

  const filePaths = path.isAbsolute(dbPath)
    ? [dbPath]
    : [absoluteDbPath, ...generatedSqliteDirNames.map((dirName) => path.resolve(project.dirPath, dirName, dbPath))];
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
