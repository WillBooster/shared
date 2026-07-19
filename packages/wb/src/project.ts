import fs from 'node:fs';
import path from 'node:path';

import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import {
  getDeclaredWorkspacePatterns,
  readEnvironmentVariables,
  resolveBunWorkspacePackageJsonPaths,
  resolveFallbackWbEnv,
  shouldSuppressEnvironmentOutput,
} from '@willbooster/shared-lib-node/src';
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

    const [envVars, envPathAndLoadedEnvVarNamePairs] = readEnvironmentVariables(this.argv, this.dirPath, {
      // completeAndValidateWbEnv below fills an unset WB_ENV with the same fallback, so expanding
      // ${WB_ENV} references against it keeps the pair consistent.
      expandFallbackWbEnv: true,
    });
    if (!shouldSuppressEnvironmentOutput(this.argv)) {
      for (const [envPath, names] of envPathAndLoadedEnvVarNamePairs) {
        console.info(`Loaded ${names.length} environment variables from ${envPath}`);
      }
    }
    // Spreading envVars last is safe for exported-variable precedence: readEnvironmentVariables
    // already excludes keys present in process.env from .env/fnox sources (returning a key that
    // exists in process.env only for deliberate forced-mode overrides). Mise values that
    // differ from the ambient activation are deliberately kept so the requested cascade profile
    // (e.g. `--cascade-env=test`) wins over a stale `mise activate` environment.
    this.envCache = { ...process.env, ...envVars };
    // `mise env` is excluded: it reports tool-activation output (e.g. PATH) even in repos that
    // declare no environment variables at all, which must not trigger the CI strictness below.
    this.completeAndValidateWbEnv(envPathAndLoadedEnvVarNamePairs.some(([source]) => !source.startsWith('mise env')));
    return this.envCache;
  }

  private static readonly standardWbEnvModes = new Set(['development', 'test', 'staging', 'production']);

  /**
   * Completes and validates the resolved `WB_ENV` per the org standard (see the
   * guidelines-for-mise-fnox skill):
   * - Locally, an unset `WB_ENV` falls back to the selected cascade mode (development unless a
   *   command forces another, e.g. `wb test` forces test), so casual `bun wb ...` invocations
   *   work in repositories that define no WB_ENV at all.
   * - On CI, an unset `WB_ENV` is a hard error when env sources exist: workflows must export the
   *   environment explicitly instead of silently running in an ambiguous mode.
   * - The value must name a standard mode; an unknown value (e.g. a typo like `prodcution`) would
   *   otherwise silently select the development cascade, which is the failure this guards against.
   * - `NEXT_PUBLIC_WB_ENV` is derived from `WB_ENV` for Next.js/vinext apps when missing, so a
   *   production build can no longer bake a stale development value into the client bundle.
   * Skipped when `WB_SKIP_ENV_CHECK=1` is set.
   */
  private completeAndValidateWbEnv(hasEnvironmentSources: boolean): void {
    const env = this.envCache;
    if (!env) return;
    if (env.WB_SKIP_ENV_CHECK === '1' || env.WB_SKIP_ENV_CHECK === 'true') return;

    // On CI, WB_ENV must be EXPORTED by the workflow — checked against process.env, not the
    // merged environment: a committed base default (e.g. fnox's development entry) would
    // otherwise satisfy the check and silently run CI in development mode.
    if (isCI(env.CI) && !process.env.WB_ENV && hasEnvironmentSources) {
      console.error(
        chalk.red(
          'WB_ENV is not exported on CI. Export WB_ENV explicitly (the reusable workflows pass it via the "environment" input), ' +
            'or set WB_SKIP_ENV_CHECK=1 to skip this check.'
        )
      );
      process.exit(1);
    }
    if (!env.WB_ENV) {
      // The shared resolver keeps this fallback consistent with the cascade selection AND with
      // the ${WB_ENV} expansion readEnvironmentVariables already performed: the forced cascade
      // (e.g. `wb test`), then the command-level default, then the AMBIENT-NODE_ENV-driven auto
      // cascade clamped to a standard mode (an explicit --cascade-env keeps its value and is
      // validated below like any other WB_ENV).
      const mode = resolveFallbackWbEnv(this.argv);
      env.WB_ENV = mode;
      if (hasEnvironmentSources && !shouldSuppressEnvironmentOutput(this.argv)) {
        console.info(`WB_ENV is not defined; defaulting to "${mode}".`);
      }
    }
    if (!Project.standardWbEnvModes.has(env.WB_ENV)) {
      console.error(
        chalk.red(
          `WB_ENV must be one of development, test, staging, or production, but is "${env.WB_ENV}". ` +
            'Fix the value in the env source or the exported variable, or set WB_SKIP_ENV_CHECK=1 to skip this check.'
        )
      );
      process.exit(1);
    }
    // A forced mode (an explicit/command-default --cascade-env, or an exported WB_ENV whose
    // mode-specific files may override it locally per issue #930) must not be silently replaced
    // by another mode a mode file defines: `wb test` resolving WB_ENV=development from a
    // committed `.env` would run the tests against development values, and an exported
    // WB_ENV=production overridden to development by `.env.production` would build/deploy the
    // wrong environment while looking successful.
    // --cascade-node-env forces <NODE_ENV || development> (per its own documentation), read from
    // the AMBIENT environment like the cascade selection. Only a STANDARD forced mode is enforced:
    // a non-standard one (e.g. NODE_ENV=qa) already had its fallback clamped to development above,
    // and erroring on that clamp would contradict it.
    const forcedMode =
      this.argv.cascadeEnv ??
      (this.argv.cascadeNodeEnv ? process.env.NODE_ENV || 'development' : process.env.WB_ENV || undefined);
    // The AUTO-selected mode counts as the expectation too: with nothing set anywhere, the
    // development cascade's files are loaded, so a `.env.local` declaring WB_ENV=production would
    // otherwise run development sources labeled as production.
    const expectedMode =
      forcedMode ?? (this.argv.autoCascadeEnv !== false ? resolveFallbackWbEnv(this.argv) : undefined);
    // The command-level default is a legitimate second expectation: `wb test --cascade-env=staging`
    // loads the staging files while the fallback correctly fills WB_ENV=test.
    if (
      expectedMode &&
      Project.standardWbEnvModes.has(expectedMode) &&
      env.WB_ENV !== expectedMode &&
      env.WB_ENV !== this.argv.commandDefaultWbEnv
    ) {
      console.error(
        chalk.red(
          `WB_ENV resolves to "${env.WB_ENV}" although the "${expectedMode}" environment was selected. ` +
            `Fix the WB_ENV defined in the mode's env source (e.g. .env.${expectedMode} or the fnox "${expectedMode}" profile), ` +
            'or set WB_SKIP_ENV_CHECK=1 to skip this check.'
        )
      );
      process.exit(1);
    }
    if (this.requiresNextPublicWbEnv && env.NEXT_PUBLIC_WB_ENV !== env.WB_ENV) {
      // Assign unconditionally, not `||=`: the pair must agree by convention, and a stale value
      // (e.g. a base `.env`'s development default while CI exports WB_ENV=test) would otherwise
      // be baked into the client bundle even though the server side runs with the correct WB_ENV.
      if (env.NEXT_PUBLIC_WB_ENV && !shouldSuppressEnvironmentOutput(this.argv)) {
        console.info(`Overriding NEXT_PUBLIC_WB_ENV ("${env.NEXT_PUBLIC_WB_ENV}") with WB_ENV ("${env.WB_ENV}").`);
      }
      env.NEXT_PUBLIC_WB_ENV = env.WB_ENV;
    }
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

/**
 * The root project followed by one Project per workspace directory the target repository's
 * package manager would link (issue #1008): Bun repos use the shared Bun-exact resolver
 * (negations, pinned positives, and baseline-seeding negations included), while Yarn repos keep
 * glob semantics — Bun-only rules such as the implicit baseline would invent workspaces Yarn
 * never links.
 */
async function getAllDescendantProjects(
  argv: EnvReaderOptions,
  rootProject: Project,
  loadEnv: boolean
): Promise<Project[]> {
  const workspaceDirPaths = await findWorkspacePackageDirs(rootProject);
  return [rootProject, ...workspaceDirPaths.map((workspaceDirPath) => new Project(workspaceDirPath, argv, loadEnv))];
}

/**
 * The absolute directory of every workspace the target repository's package manager would link,
 * matching the manager the way getAllDescendantProjects describes. Exported for wb release, whose
 * plugin inspection, node_modules cleanup, and manifest rewriting must see the same workspace set.
 */
export async function findWorkspacePackageDirs(
  project: Pick<Project, 'dirPath' | 'packageJson' | 'usesBunPackageManager'>
): Promise<string[]> {
  if (project.usesBunPackageManager) {
    return resolveBunWorkspacePackageJsonPaths(project.packageJson.workspaces, project.dirPath).map((packageJsonPath) =>
      path.join(project.dirPath, path.posix.dirname(packageJsonPath))
    );
  }
  // Yarn 1.22.22 resolves each declared pattern (array or `{ packages: […] }` form) independently
  // and unions the results, so a leading-`!` pattern is not an exclusion — `["packages/*",
  // "!packages/a"]` still links packages/a. Yarn additionally ignores manifests missing a name or
  // version ("Missing version in workspace …, ignoring."), but that is deliberately NOT mirrored:
  // wb's descendant discovery exists to run commands (lint, test, typecheck, …) in sub-packages,
  // and version-less private packages must stay discovered — the long-standing behavior wb's
  // monorepo fixtures encode. Glob for the manifests themselves: globby's `onlyDirectories`
  // would return a literal directory pattern's CHILDREN instead of the directory. The realpath
  // containment mirrors resolveWorkspacePackageJsonPaths: a workspace symlink escaping the
  // repository must not let consumers touch another checkout.
  const positivePatterns = getDeclaredWorkspacePatterns(project.packageJson.workspaces).filter(
    (pattern) => !pattern.startsWith('!')
  );
  if (positivePatterns.length === 0) return [];
  // expandDirectories: false — globby would otherwise expand a literal directory pattern to its
  // CHILDREN, turning e.g. `packages` into matches for every packages/* subdirectory.
  const globbyOptions = {
    cwd: project.dirPath,
    expandDirectories: false,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**'],
  };
  // fast-glob (globby's engine) returns no matches for file globs with a lone-`?` segment (e.g.
  // `packages/?/package.json`) although Yarn links such workspaces; for `?`-carrying patterns
  // only (a directory glob for e.g. `**` would scan every directory in the repository), globbing
  // the directories (where `?` works) and checking their manifests complements the manifest glob.
  const globbedManifestPaths = await globby(
    positivePatterns.map((pattern) => path.posix.join(pattern, 'package.json')),
    globbyOptions
  );
  const manifestPathSet = new Set(globbedManifestPaths);
  const questionMarkPatterns = positivePatterns.filter((pattern) => pattern.includes('?'));
  if (questionMarkPatterns.length > 0) {
    for (const dirPath of await globby(questionMarkPatterns, { ...globbyOptions, onlyDirectories: true })) {
      const manifestPath = path.posix.join(dirPath, 'package.json');
      if (fs.existsSync(path.join(project.dirPath, manifestPath))) manifestPathSet.add(manifestPath);
    }
  }
  const manifestPaths = [...manifestPathSet];
  const realRootDirPath = fs.realpathSync(project.dirPath);
  const workspaceDirPaths = manifestPaths
    // A `**` pattern reaches the root's own manifest and installed packages, but neither is a
    // workspace to Yarn (which never descends into node_modules).
    .filter((manifestPath) => {
      if (manifestPath === 'package.json') return false;
      try {
        const relativePath = path.relative(realRootDirPath, fs.realpathSync(path.join(project.dirPath, manifestPath)));
        return relativePath !== '..' && !relativePath.startsWith('../') && !path.isAbsolute(relativePath);
      } catch {
        // The manifest vanished between the glob and the realpath call: not a workspace.
        return false;
      }
    })
    .map((manifestPath) => path.join(project.dirPath, path.posix.dirname(manifestPath)));
  return [...new Set(workspaceDirPaths)].toSorted();
}
