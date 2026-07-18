import fs from 'node:fs';
import path from 'node:path';

import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import { readEnvironmentVariables, shouldSuppressEnvironmentOutput } from '@willbooster/shared-lib-node/src';
import { memoizeOne } from 'at-decorators';
import chalk from 'chalk';
import { globby } from 'globby';
import type { PackageJson } from 'type-fest';

import { prependNodeModulesBinToPath } from './utils/binPath.js';
import { isCI } from './utils/ci.js';

export type DatabaseOrm = 'prisma' | 'drizzle';

export const FILE_SCHEMA = 'file:';

export class Project {
  private readonly argv: EnvReaderOptions;
  private readonly loadEnv: boolean;
  private readonly pathByName = new Map<string, string>();

  private readonly _dirPath: string;

  constructor(dirPath: string, argv: EnvReaderOptions, loadEnv: boolean) {
    this._dirPath = path.resolve(dirPath);
    this.argv = argv;
    this.loadEnv = loadEnv;
  }

  @memoizeOne
  get isBunAvailable(): boolean {
    return this.usesBunPackageManager;
  }

  // The package manager must follow the target project, not the runtime that launched wb:
  // `node wb ...` against a Bun repo must still run `bun install`, and vice versa.
  get packageManagerCommand(): 'bun' | 'yarn' {
    return this.isBunAvailable ? 'bun' : 'yarn';
  }

  get packageManagerRunCommand(): 'bun run' | 'yarn' {
    return this.isBunAvailable ? 'bun run' : 'yarn';
  }

  // A single signal decides every bun-vs-yarn branch in wb (script normalization included):
  // splitting the tool-manifest signal from the lockfile signal once produced commands mixing
  // `bun install` with `yarn prisma ...` in mise-pinned repos whose bun.lock is gitignored.
  @memoizeOne
  get usesBunPackageManager(): boolean {
    if (this.hasBunToolVersion()) return true;
    if (this.hasBunLockfile()) return true;
    return this.hasBunPackageManager();
  }

  private hasBunToolVersion(): boolean {
    // wbfy migrates .tool-versions into mise.toml, so a mise-pinned bun must count as well:
    // repos that gitignore bun.lock and have no packageManager field rely on the tool manifest.
    if (testFileContent(path.join(this.rootDirPath, '.tool-versions'), /(^|\n)bun\s/)) return true;
    return ['mise.toml', '.mise.toml'].some((fileName) =>
      testFileContent(path.join(this.rootDirPath, fileName), /^\s*(?:"bun"|bun)\s*=/m)
    );
  }

  private hasBunLockfile(): boolean {
    // Some repositories rely on the lockfile or packageManager field instead of mise.
    // Docker optimization must follow the target project, not the runtime that launched wb.
    return ['bun.lock', 'bun.lockb'].some((fileName) => fs.existsSync(path.join(this.rootDirPath, fileName)));
  }

  private hasBunPackageManager(): boolean {
    const packageManager = this.rootPackageJson?.packageManager ?? this.packageJson.packageManager;
    return typeof packageManager === 'string' && packageManager.startsWith('bun@');
  }

  @memoizeOne
  get buildCommand(): string {
    return this.packageJson.scripts?.build?.includes('buildIfNeeded')
      ? 'YARN run build'
      : this.packageJson.scripts?.build
        ? `YARN wb buildIfNeeded ${this.argv.verbose ? '--verbose' : ''}`
        : "echo 'No build script'";
  }

  get dirPath(): string {
    return this._dirPath;
  }

  @memoizeOne
  get rootDirPath(): string {
    return fs.existsSync(path.join(this.dirPath, '..', '..', 'package.json'))
      ? path.resolve(this.dirPath, '..', '..')
      : this.dirPath;
  }

  @memoizeOne
  get dockerfile(): string {
    return fs.readFileSync(this.findFile('Dockerfile'), 'utf8');
  }

  @memoizeOne
  get hasDockerfile(): boolean {
    try {
      return !!this.findFile('Dockerfile');
    } catch {
      return false;
    }
  }

  @memoizeOne
  get hasSourceCode(): boolean {
    return fs.existsSync(path.join(this.dirPath, 'src'));
  }

  @memoizeOne
  get name(): string {
    return this.packageJson.name || 'unknown';
  }

  @memoizeOne
  get dockerImageName(): string {
    const name = this.packageJson.name || 'unknown';
    return name.replaceAll('@', '').replaceAll('/', '-');
  }

  // Cached in a plain field rather than with @memoizeOne: that decorator keys its cache on a hash
  // of the instance, which changes as other memoized getters populate the instance, so `env` could
  // silently be recomputed — dropping in-place mutations (e.g. `project.env.PORT ||= …`, or the
  // secrets `wb deploy` merges from .env.cloudflare) that callers rely on for spawned commands.
  private envCache: Record<string, string | undefined> | undefined;

  get env(): Record<string, string | undefined> {
    if (this.envCache) return this.envCache;
    if (!this.loadEnv) {
      this.envCache = process.env;
      return this.envCache;
    }

    const [envVars, envPathAndLoadedEnvVarCountPairs] = readEnvironmentVariables(this.argv, this.dirPath);
    if (!shouldSuppressEnvironmentOutput(this.argv)) {
      for (const [envPath, count] of envPathAndLoadedEnvVarCountPairs) {
        console.info(`Loaded ${count} environment variables from ${envPath}`);
      }
    }
    // Spreading envVars last is safe for exported-variable precedence: readEnvironmentVariables
    // already excludes keys present in process.env from .env/fnox sources (returning a key that
    // exists in process.env only for deliberate forced-mode overrides). Mise values that
    // differ from the ambient activation are deliberately kept so the requested cascade profile
    // (e.g. `--cascade-env=test`) wins over a stale `mise activate` environment.
    this.envCache = { ...process.env, ...envVars };
    // `mise env` is excluded: it reports tool-activation output (e.g. PATH) even in repos that
    // declare no environment variables at all, which must not force the WB_ENV requirement.
    this.validateRequiredEnvironmentVariables(
      envPathAndLoadedEnvVarCountPairs.some(([source]) => !source.startsWith('mise env'))
    );
    return this.envCache;
  }

  /**
   * Fail fast when the resolved environment violates the org standard: every mode
   * (development/test/staging/production) must define `WB_ENV`, and Next.js/vinext apps must also
   * define `NEXT_PUBLIC_WB_ENV` (see the guidelines-for-mise-fnox skill). Skipped while no env
   * sources exist yet (e.g. during `wb setup` bootstrap before env files/fnox.toml are created)
   * and when `WB_SKIP_ENV_CHECK=1` is set.
   */
  private validateRequiredEnvironmentVariables(hasEnvironmentSources: boolean): void {
    const env = this.envCache;
    if (!env || !hasEnvironmentSources) return;
    if (env.WB_SKIP_ENV_CHECK === '1' || env.WB_SKIP_ENV_CHECK === 'true') return;

    const missingKeys: string[] = [];
    if (!env.WB_ENV) missingKeys.push('WB_ENV');
    if (this.requiresNextPublicWbEnv && !env.NEXT_PUBLIC_WB_ENV) missingKeys.push('NEXT_PUBLIC_WB_ENV');
    if (missingKeys.length === 0) return;

    // Resolve the mode label from the loaded environment (not process.env): a WB_ENV/NODE_ENV
    // supplied only by env files or fnox must still name the correct mode in the error message.
    const mode =
      this.argv.cascadeEnv ??
      (this.argv.cascadeNodeEnv ? env.NODE_ENV || 'development' : (env.WB_ENV ?? env.NODE_ENV ?? 'development'));
    console.error(
      chalk.red(
        `${missingKeys.join(' and ')} ${missingKeys.length === 1 ? 'is' : 'are'} not defined for the "${mode}" environment. ` +
          `Define ${missingKeys.join(' and ')} in the mode's env source (e.g. .env.${mode} or the fnox "${mode}" profile; see guidelines-for-mise-fnox), ` +
          'or set WB_SKIP_ENV_CHECK=1 to skip this check.'
      )
    );
    process.exit(1);
  }

  @memoizeOne
  private get requiresNextPublicWbEnv(): boolean {
    // OWN dependencies only: a root-level next/vinext devDependency in a mixed monorepo must not
    // force NEXT_PUBLIC_WB_ENV onto every non-Next workspace package.
    return !!this.getOwnDependencyVersion('next') || !!this.getOwnDependencyVersion('vinext');
  }

  @memoizeOne
  get packageJson(): PackageJson {
    return JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf8')) as PackageJson;
  }

  @memoizeOne
  get packageJsonPath(): string {
    return path.join(this.dirPath, 'package.json');
  }

  @memoizeOne
  get hasPrisma(): boolean {
    return !!this.getOwnDependencyVersion('prisma');
  }

  @memoizeOne
  get hasDrizzle(): boolean {
    return !!this.getOwnDependencyVersion('drizzle-orm');
  }

  @memoizeOne
  get databaseOrm(): DatabaseOrm | undefined {
    if (this.hasPrisma) return 'prisma';
    if (this.hasDrizzle) return 'drizzle';
    return;
  }

  @memoizeOne
  get hasVitest(): boolean {
    return !!(this.packageJson.dependencies?.vitest ?? this.packageJson.devDependencies?.vitest);
  }

  @memoizeOne
  get hasOxlint(): boolean {
    return this.hasDependency('oxlint');
  }

  @memoizeOne
  get hasTypeAwareOxlint(): boolean {
    // Oxlint's type-aware mode requires the oxlint-tsgolint binary.
    return this.hasOxlint && this.hasDependency('oxlint-tsgolint');
  }

  @memoizeOne
  get hasOxfmt(): boolean {
    return this.hasDependency('oxfmt');
  }

  @memoizeOne
  get hasPrettier(): boolean {
    return this.hasDependency('prettier');
  }

  @memoizeOne
  get hasPoetryLock(): boolean {
    return (
      fs.existsSync(path.join(this.dirPath, 'poetry.lock')) || fs.existsSync(path.join(this.rootDirPath, 'poetry.lock'))
    );
  }

  @memoizeOne
  get hasPubspecYaml(): boolean {
    return (
      fs.existsSync(path.join(this.dirPath, 'pubspec.yaml')) ||
      fs.existsSync(path.join(this.rootDirPath, 'pubspec.yaml'))
    );
  }

  @memoizeOne
  get hasCargoToml(): boolean {
    // Only the project's own directory is checked because `cargo fmt --all`
    // covers the whole workspace; matching the root directory too would make
    // every descendant project run the same workspace-wide command in
    // parallel.
    return fs.existsSync(path.join(this.dirPath, 'Cargo.toml'));
  }

  @memoizeOne
  get preferredLinter(): 'oxlint' | undefined {
    if (this.hasOxlint) return 'oxlint';
    return;
  }

  hasOwnDependency(packageName: string): boolean {
    return !!this.getOwnDependencyVersion(packageName);
  }

  @memoizeOne
  get hasPlaywrightConfig(): boolean {
    try {
      return !!this.findFile('playwright.config.ts');
    } catch {
      return false;
    }
  }

  @memoizeOne
  get skipLaunchingServerForPlaywright(): boolean {
    if (isCI(this.env.CI)) return false;
    try {
      const configPath = this.findFile('playwright.config.ts');
      return /\bwebServer\b/.test(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return false;
    }
  }

  @memoizeOne
  get dockerPackageJson(): PackageJson {
    return path.dirname(this.findFile('Dockerfile')) === this.dirPath
      ? this.packageJson
      : (JSON.parse(
          fs.readFileSync(path.join(path.dirname(this.findFile('Dockerfile')), 'package.json'), 'utf8')
        ) as PackageJson);
  }

  @memoizeOne
  get binExists(): boolean {
    return prependNodeModulesBinToPath(this.dirPath, this.env);
  }

  findFile(fileName: string): string {
    let filePath = this.pathByName.get(fileName);
    if (filePath) return filePath;

    filePath = [fileName, path.join('..', '..', fileName)]
      .map((p) => path.resolve(this.dirPath, p))
      .find((p) => fs.existsSync(p));
    if (!filePath) {
      throw new Error(`File not found: ${fileName}`);
    }
    this.pathByName.set(fileName, filePath);
    return filePath;
  }

  private hasDependency(packageName: string): boolean {
    return !!(
      this.getOwnDependencyVersion(packageName) ?? this.getDependencyVersion(this.rootPackageJson, packageName)
    );
  }

  private getOwnDependencyVersion(packageName: string): string | undefined {
    return this.getDependencyVersion(this.packageJson, packageName);
  }

  private getDependencyVersion(packageJson: PackageJson | undefined, packageName: string): string | undefined {
    if (!packageJson) return;

    return (
      packageJson.dependencies?.[packageName] ??
      packageJson.devDependencies?.[packageName] ??
      packageJson.optionalDependencies?.[packageName] ??
      packageJson.peerDependencies?.[packageName]
    );
  }

  @memoizeOne
  private get rootPackageJson(): PackageJson | undefined {
    if (this.rootDirPath === this.dirPath) return this.packageJson;

    try {
      return JSON.parse(fs.readFileSync(path.join(this.rootDirPath, 'package.json'), 'utf8')) as PackageJson;
    } catch (error) {
      console.error(`[wb] Failed to read or parse ${path.join(this.rootDirPath, 'package.json')}`, error);
      return;
    }
  }
}

export function getFileDatabaseUrlPath(project: Pick<Project, 'env'>): string | undefined {
  const dbUrl = project.env.DATABASE_URL;
  if (!dbUrl?.startsWith(FILE_SCHEMA)) return;

  const rawPath = dbUrl.slice(FILE_SCHEMA.length).replace(/[?#].*$/, '');
  const normalizedPath = rawPath.startsWith('//') ? rawPath.slice(2) : rawPath;
  return normalizedPath || undefined;
}

export function getAbsoluteFileDatabaseUrlPath(
  project: Pick<Project, 'env'> & Partial<Pick<Project, 'dirPath' | 'rootDirPath'>>
): string | undefined {
  const dbPath = getFileDatabaseUrlPath(project);
  if (!dbPath) return;

  if (path.isAbsolute(dbPath)) return dbPath;

  const baseDirPath = project.rootDirPath ?? project.dirPath;
  return baseDirPath ? path.resolve(baseDirPath, dbPath) : undefined;
}

export interface FoundProjects {
  root: Project;
  self: Project;
  descendants: Project[];
}

export function findSelfProject(argv: EnvReaderOptions, loadEnv = true, dirPath?: string): Project | undefined {
  dirPath ??= process.cwd();
  if (!fs.existsSync(path.join(dirPath, 'package.json'))) return;

  return new Project(dirPath, argv, loadEnv);
}

export function isProjectEnvironment(project: Project, name: string): boolean {
  return project.env.WB_ENV === name || project.env.MISE_ENV === name;
}

export async function findDescendantProjects(
  argv: EnvReaderOptions,
  loadEnv = true,
  dirPath?: string
): Promise<FoundProjects | undefined> {
  const rootAndSelfProjects = findRootAndSelfProjects(argv, loadEnv, dirPath);
  if (!rootAndSelfProjects) return;

  return {
    ...rootAndSelfProjects,
    descendants:
      rootAndSelfProjects.root === rootAndSelfProjects.self
        ? await getAllDescendantProjects(argv, rootAndSelfProjects.root, loadEnv)
        : [rootAndSelfProjects.self],
  };
}

export function findRootAndSelfProjects(
  argv: EnvReaderOptions,
  loadEnv = true,
  dirPath?: string
): Omit<FoundProjects, 'descendants'> | undefined {
  dirPath ??= process.cwd();
  if (!fs.existsSync(path.join(dirPath, 'package.json'))) return;

  const thisProject = new Project(dirPath, argv, loadEnv);
  let rootProject = thisProject;
  if (!thisProject.packageJson.workspaces && path.dirname(dirPath).endsWith('/packages')) {
    const rootDirPath = path.resolve(dirPath, '..', '..');
    if (fs.existsSync(path.join(rootDirPath, 'package.json'))) {
      rootProject = new Project(rootDirPath, argv, loadEnv);
    }
  }
  return { root: rootProject, self: thisProject };
}

function testFileContent(filePath: string, pattern: RegExp): boolean {
  try {
    return pattern.test(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
}

async function getAllDescendantProjects(
  argv: EnvReaderOptions,
  rootProject: Project,
  loadEnv: boolean
): Promise<Project[]> {
  const projects = [rootProject];

  const workspace = rootProject.packageJson.workspaces;
  if (!Array.isArray(workspace)) return projects;

  const globPattern: string[] = [];
  const packageDirs: string[] = [];
  for (const workspacePath of workspace.map((ws: string) => path.join(rootProject.dirPath, ws))) {
    if (fs.existsSync(workspacePath)) {
      packageDirs.push(workspacePath);
    } else {
      globPattern.push(workspacePath);
    }
  }
  packageDirs.push(...(await globby(globPattern, { dot: true, onlyDirectories: true })));
  for (const subPackageDirPath of packageDirs) {
    if (!fs.existsSync(path.join(subPackageDirPath, 'package.json'))) continue;

    projects.push(new Project(subPackageDirPath, argv, loadEnv));
  }
  return projects;
}
