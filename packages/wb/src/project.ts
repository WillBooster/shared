import fs from 'node:fs';
import path from 'node:path';

import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import {
  getDeclaredWorkspacePatterns,
  isInRepositoryWorkspacePattern,
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
import { selectFnoxSourcedKeys } from './utils/envSources.js';
import { hasBunDirectoryMarker, isBunPackageManager, isExplicitNonBunPackageManager } from './utils/runtime.js';
import { clearTestStructureCache } from './utils/testStructure.js';
import { findWranglerConfigPath } from './utils/wrangler.js';

/** The file `wrangler types` writes by default. */
const WORKER_TYPES_FILE_NAME = 'worker-configuration.d.ts';

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
    // Some repositories rely on the lockfile or packageManager field instead of mise.
    // Docker optimization must follow the target project, not the runtime that launched wb.
    const packageManager = this.rootPackageJson?.packageManager ?? this.packageJson.packageManager;
    if (isExplicitNonBunPackageManager(packageManager)) return false;
    if (hasBunDirectoryMarker(this.rootDirPath)) return true;
    return isBunPackageManager(packageManager);
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

  /** A workspace root without sources of its own runs neither lint nor typecheck commands. */
  @memoizeOne
  get hasOwnSourceCode(): boolean {
    return !this.packageJson.workspaces || this.hasSourceCode;
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

  private declaredEnvKeyCache: Set<string> | undefined;

  /**
   * The names of the environment variables the PROJECT declares (its fnox sources), excluding
   * both the ambient process environment and the `mise env` pseudo-source that reports host/tool
   * variables such as PATH. `env` cannot answer this: it merges process.env, so a project variable
   * is indistinguishable from an inherited one there.
   */
  get declaredEnvKeys(): Set<string> {
    if (this.declaredEnvKeyCache) return this.declaredEnvKeyCache;
    if (!this.loadEnv) {
      this.declaredEnvKeyCache = new Set();
      return this.declaredEnvKeyCache;
    }
    const [, envSources] = readEnvironmentVariables(this.argv, this.dirPath, { ignoreProcessEnv: true });
    this.declaredEnvKeyCache = selectFnoxSourcedKeys(envSources);
    return this.declaredEnvKeyCache;
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

    const [mergedEnv, envPathAndLoadedEnvVarNamePairs] = readAndMergeEnvironmentVariables(this.argv, this.dirPath);
    this.envCache = mergedEnv;
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
    // profile values may override it locally per issue #930) must not be silently replaced by
    // another mode an env source defines: `wb test` resolving WB_ENV=development from the base
    // fnox secrets would run the tests against development values, and an exported
    // WB_ENV=production overridden to development by the production profile would build/deploy
    // the wrong environment while looking successful.
    // --cascade-node-env forces <NODE_ENV || development> (per its own documentation), read from
    // the AMBIENT environment like the cascade selection. Only a STANDARD forced mode is enforced:
    // a non-standard one (e.g. NODE_ENV=qa) already had its fallback clamped to development above,
    // and erroring on that clamp would contradict it.
    const forcedMode =
      this.argv.cascadeEnv ??
      (this.argv.cascadeNodeEnv ? process.env.NODE_ENV || 'development' : process.env.WB_ENV || undefined);
    // The AUTO-selected mode counts as the expectation too: with nothing set anywhere, the
    // development values are loaded, so an env source declaring WB_ENV=production would
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
            `Fix the WB_ENV defined in the mode's env source (e.g. the fnox "${expectedMode}" profile), ` +
            'or set WB_SKIP_ENV_CHECK=1 to skip this check.'
        )
      );
      process.exit(1);
    }
    if (this.requiresNextPublicWbEnv && env.NEXT_PUBLIC_WB_ENV !== env.WB_ENV) {
      // Assign unconditionally, not `||=`: the pair must agree by convention, and a stale value
      // (e.g. the fnox base development default while CI exports WB_ENV=test) would otherwise
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

  /**
   * Whether `wrangler types` should generate `worker-configuration.d.ts` here. A wrangler config
   * and an own wrangler dependency are both required — wrangler exits non-zero without a config,
   * and in a mixed monorepo a root-level wrangler devDependency must not make every workspace
   * package emit types it never consumes.
   *
   * The package's own committed gitignore rule is the third signal, and the one that says the
   * package actually CONSUMES the file: wbfy writes that rule only for packages whose own tsconfig
   * can reference `worker-configuration.d.ts`, and deliberately leaves alone packages that
   * hand-maintain their `Env` instead. Without this check, such a package would gain an untracked
   * ~500KB generated file on every install.
   */
  @memoizeOne
  get generatesWorkerTypes(): boolean {
    if (!findWranglerConfigPath(this) || !this.hasOwnDependency('wrangler')) return false;
    // Defense in depth against wbfy's gitignore rule and this predicate drifting apart: if the package still
    // runs its own output-changing `wrangler types` (e.g. `--strict-vars=false`), the bare invocation here would
    // overwrite that file with a different `Env`.
    if (hasOutputChangingWranglerTypes(this.packageJson.scripts ?? {})) return false;
    return hasManagedGitignoreRule(this.dirPath, WORKER_TYPES_FILE_NAME);
  }

  @memoizeOne
  get hasPrisma(): boolean {
    return !!this.getOwnDependencyVersion('prisma');
  }

  /** Blitz repositories keep their Prisma schema and SQLite databases under db/ instead of prisma/. */
  @memoizeOne
  get prismaDirName(): string {
    return fs.existsSync(path.join(this.dirPath, 'db', 'schema.prisma')) ? 'db' : 'prisma';
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

  /**
   * Whether the Playwright config declares a `webServer` block, i.e. Playwright itself builds and
   * starts the app under test. Unlike {@link skipLaunchingServerForPlaywright} this ignores CI, so
   * it also holds for library fixtures whose only server is the one Playwright manages.
   */
  @memoizeOne
  get hasPlaywrightWebServerConfig(): boolean {
    try {
      const configPath = this.findFile('playwright.config.ts');
      return /\bwebServer\b/.test(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return false;
    }
  }

  @memoizeOne
  get skipLaunchingServerForPlaywright(): boolean {
    // On CI wb launches the app itself so the run does not depend on Playwright's `reuseExistingServer`
    // (which is disabled on CI); locally, a `webServer` block means Playwright already owns the server.
    if (isCI(this.env.CI)) return false;
    return this.hasPlaywrightWebServerConfig;
  }

  @memoizeOne
  get dockerPackageJson(): PackageJson {
    const dockerfileDirPath = path.dirname(this.findFile('Dockerfile'));
    return dockerfileDirPath === this.dirPath
      ? this.packageJson
      : (JSON.parse(fs.readFileSync(path.join(dockerfileDirPath, 'package.json'), 'utf8')) as PackageJson);
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

/**
 * Reads the project's env sources and merges them over process.env, reporting each loaded source.
 * Shared by Project.env and `wb run`'s standalone (manifest-less) environment loading.
 */
export function readAndMergeEnvironmentVariables(
  argv: EnvReaderOptions,
  dirPath: string
): [Record<string, string | undefined>, [string, string[]][]] {
  const [envVars, envPathAndLoadedEnvVarNamePairs] = readEnvironmentVariables(argv, dirPath, {
    // Callers fill an unset WB_ENV with the same fallback afterwards, so expanding ${WB_ENV}
    // references against it keeps the pair consistent.
    expandFallbackWbEnv: true,
  });
  if (!shouldSuppressEnvironmentOutput(argv)) {
    for (const [envPath, names] of envPathAndLoadedEnvVarNamePairs) {
      console.info(`Loaded ${names.length} environment variables from ${envPath}`);
    }
  }
  // Spreading envVars last is safe for exported-variable precedence: readEnvironmentVariables
  // already excludes keys present in process.env from .env/fnox sources (returning a key that
  // exists in process.env only for deliberate forced-mode overrides). Mise values that
  // differ from the ambient activation are deliberately kept so the requested cascade profile
  // (e.g. `--cascade-env=test`) wins over a stale `mise activate` environment.
  return [{ ...process.env, ...envVars }, envPathAndLoadedEnvVarNamePairs];
}

export interface FoundProjects {
  root: Project;
  self: Project;
  descendants: Project[];
}

// Project construction re-reads manifests and env sources, and `wb verify` composes commands
// (lint, typecheck, test) that each rebuild the graph — so instances are shared per
// (directory, loadEnv, env-relevant argv) within one invocation. Sharing is safe because a
// Project is immutable except for env mutations (e.g. `project.env.PORT ||= ...`), which callers
// deliberately rely on staying visible to later steps. The caches live for the whole process and
// never observe later filesystem mutations, so code that rewrites a project directory and needs a
// fresh view (today only tests) must call clearProjectCaches first.
const selfProjectCache = new Map<string, Project>();
const descendantProjectsCache = new Map<string, Promise<Project[]>>();

export function clearProjectCaches(): void {
  selfProjectCache.clear();
  descendantProjectsCache.clear();
  clearTestStructureCache();
}

function buildProjectCacheKey(argv: EnvReaderOptions, loadEnv: boolean, dirPath: string): string {
  // Only the inputs a Project actually reads participate: the env cascade selection
  // (readEnvironmentVariables / resolveFallbackWbEnv / completeAndValidateWbEnv) and the output
  // switches (shouldSuppressEnvironmentOutput, buildCommand's --verbose). The ambient
  // WB_ENV / NODE_ENV / CI values feed the same cascade selection and are mutated mid-run by
  // commands such as `wb db reset` (which forces WB_ENV=test and re-resolves projects), so they
  // must participate too or the second resolution would reuse a Project with the wrong env.
  const { autoCascadeEnv, cascadeEnv, cascadeNodeEnv, commandDefaultWbEnv, quietEnv, verbose } = argv;
  const { silent } = argv as { silent?: boolean };
  return JSON.stringify([
    path.resolve(dirPath),
    loadEnv,
    autoCascadeEnv,
    cascadeEnv,
    cascadeNodeEnv,
    commandDefaultWbEnv,
    quietEnv,
    verbose,
    silent,
    process.env.WB_ENV,
    process.env.NODE_ENV,
    process.env.CI,
  ]);
}

export function findSelfProject(argv: EnvReaderOptions, loadEnv = true, dirPath?: string): Project | undefined {
  dirPath ??= process.cwd();
  if (!fs.existsSync(path.join(dirPath, 'package.json'))) return;

  const cacheKey = buildProjectCacheKey(argv, loadEnv, dirPath);
  let project = selfProjectCache.get(cacheKey);
  if (!project) {
    project = new Project(dirPath, argv, loadEnv);
    selfProjectCache.set(cacheKey, project);
  }
  return project;
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
  if (rootAndSelfProjects.root !== rootAndSelfProjects.self) {
    return { ...rootAndSelfProjects, descendants: [rootAndSelfProjects.self] };
  }

  const cacheKey = buildProjectCacheKey(argv, loadEnv, rootAndSelfProjects.root.dirPath);
  let descendants = descendantProjectsCache.get(cacheKey);
  if (!descendants) {
    descendants = getAllDescendantProjects(argv, rootAndSelfProjects.root, loadEnv);
    descendantProjectsCache.set(cacheKey, descendants);
  }
  return { ...rootAndSelfProjects, descendants: await descendants };
}

export function findRootAndSelfProjects(
  argv: EnvReaderOptions,
  loadEnv = true,
  dirPath?: string
): Omit<FoundProjects, 'descendants'> | undefined {
  dirPath ??= process.cwd();
  const thisProject = findSelfProject(argv, loadEnv, dirPath);
  if (!thisProject) return;

  let rootProject = thisProject;
  if (!thisProject.packageJson.workspaces && path.dirname(dirPath).endsWith('/packages')) {
    const rootDirPath = path.resolve(dirPath, '..', '..');
    rootProject = findSelfProject(argv, loadEnv, rootDirPath) ?? thisProject;
  }
  return { root: rootProject, self: thisProject };
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
  return [
    rootProject,
    ...workspaceDirPaths.map(
      // The fallback keeps a workspace whose manifest vanished after the glob (findSelfProject
      // would drop it) discovered, matching the long-standing direct construction.
      (workspaceDirPath) =>
        findSelfProject(argv, loadEnv, workspaceDirPath) ?? new Project(workspaceDirPath, argv, loadEnv)
    ),
  ];
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
    (pattern) => !pattern.startsWith('!') && isInRepositoryWorkspacePattern(pattern)
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

/**
 * Whether the package's own committed .gitignore carries wbfy's managed rule for the file.
 *
 * Deliberately NOT `git check-ignore`: that also honors `.git/info/exclude` and the user's global
 * excludes, which a fresh clone and CI do not have. A developer with a personal
 * `worker-configuration.d.ts` exclude would otherwise turn generation on for a package wbfy
 * deliberately left unmanaged, and the resulting file would be invisible in `git status`.
 * wbfy's `untrackCloudflareEnv` fixer gates on the same committed-rule check via `hasGitignoreRule`.
 */
function hasManagedGitignoreRule(dirPath: string, fileName: string): boolean {
  try {
    return fs
      .readFileSync(path.join(dirPath, '.gitignore'), 'utf8')
      .split('\n')
      .some((line) => line.trim() === `/${fileName}`);
  } catch {
    return false;
  }
}

/**
 * Whether a package script runs a `wrangler types` that would write something other than what the bare
 * invocation writes. `--check`/`--help` validate or print and write nothing, so they do not count. `--env-file`
 * never counts: `wb gen-code` supplies its own `--env-file` stub from the committed fnox.toml, which replaces
 * the dotenv inference canonically, so an env-file-only invocation is equivalent to the managed generation
 * whether or not the named files exist on this machine — and testing local existence would make this predicate
 * disagree across machines. Mirrors wbfy's `hasCustomWranglerTypesInvocation`; the two must agree, since wbfy's
 * answer decides the gitignore rule this predicate keys on.
 */
function hasOutputChangingWranglerTypes(scripts: Record<string, string | undefined>): boolean {
  const wranglerTypesPattern = /(?:^|\s)wrangler\s+types(?:\s|$)/u;
  const envFileOnlyPattern = /^(?:(?:bunx|npx)\s+|(?:yarn|pnpm)\s+dlx\s+)?wrangler\s+types(?:\s+--env-file\s+\S+)*$/u;
  return Object.values(scripts).some((script) => {
    if (!script || !wranglerTypesPattern.test(script)) return false;
    // Checked on the WHOLE script, before splitting: `cd sub && wrangler types` runs the generator in another
    // directory against another config, but its second segment alone looks like a plain invocation. wbfy
    // classifies any script carrying this syntax as custom, and the two predicates must agree.
    if (/[;|<>`$'"()]|\bcd\s/u.test(script)) return true;
    return script
      .split('&&')
      .map((segment) => segment.trim().replaceAll(/\s+/gu, ' '))
      .some((segment) => {
        if (!wranglerTypesPattern.test(segment)) return false;
        if (/(?:^|\s)(?:--help|-h)(?:\s|=|$)/u.test(segment)) return false;
        // `--check` compares the result FOR THE SUPPLIED OPTIONS, so it is only harmless when the rest of the
        // invocation is equivalent to the bare one.
        const withoutCheck = segment
          .replace(/(?:^|\s)--check(?:\s|=|$)/u, ' ')
          .replaceAll(/\s+/gu, ' ')
          .trim();
        const candidate = withoutCheck === segment ? segment : withoutCheck;
        // Not equivalent to the bare invocation, with or without `--check`: `--check` compares the result FOR
        // THE SUPPLIED OPTIONS, so `--check --strict-vars=false` still describes a different file.
        return !envFileOnlyPattern.test(candidate);
      });
  });
}
