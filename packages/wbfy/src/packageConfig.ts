import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';
import semver from 'semver';
import { simpleGit } from 'simple-git';
import { parse as parseToml } from 'smol-toml';
import type { PackageJson } from 'type-fest';
import { z } from 'zod';

import { getOctokit, gitHubUtil } from './utils/githubUtil.js';
import { globIgnore } from './utils/globUtil.js';
import { jsoncUtil } from './utils/jsoncUtil.js';
import { spawnSyncAndReturnStdout } from './utils/spawnUtil.js';
import { selectProjectWranglerTypesGenerator } from './utils/wranglerTypesCommand.js';
import { getWorkspacePackageJsonPaths } from './utils/workspaceUtil.js';

export interface PackageConfig {
  dirPath: string;
  dockerfile: string;
  isRoot: boolean;
  isPublicRepo: boolean;
  isReferredByOtherRepo: boolean;
  repository?: string;
  repoAuthor?: string;
  repoName?: string;
  isWillBoosterRepo: boolean;
  isCloudflare: boolean;
  doesContainWranglerConfig: boolean;
  isRailway: boolean;
  isEsmPackage: boolean;
  isWillBoosterConfigs: boolean;
  // dependency information
  /** Directories containing Cargo.toml (relative to dirPath, root-most first). Empty if the repo has no Rust code. */
  cargoTomlDirPaths: string[];
  doesContainSubPackageJsons: boolean;
  doesContainDockerfile: boolean;
  doesContainGemfile: boolean;
  doesContainGoMod: boolean;
  doesContainPackageJson: boolean;
  doesContainPoetryLock: boolean;
  doesContainUvLock: boolean;
  doesContainPomXml: boolean;
  doesContainPubspecYaml: boolean;
  doesContainTauriConfig: boolean;
  doesContainTauriConfigInPackages: boolean;
  doesContainTemplateYaml: boolean;
  doesContainVscodeSettingsJson: boolean;
  // source code files
  doesContainJavaScript: boolean;
  doesContainTypeScript: boolean;
  doesContainJsxOrTsx: boolean;
  doesContainJava: boolean;
  doesContainJavaScriptInPackages: boolean;
  doesContainTypeScriptInPackages: boolean;
  doesContainJsxOrTsxInPackages: boolean;
  doesContainJavaInPackages: boolean;

  depending: {
    blitz: boolean;
    firebase: boolean;
    genI18nTs: boolean;
    litestream: boolean;
    next: boolean;
    playwrightTest: boolean;
    playwrightRuntime: boolean;
    prisma: boolean;
    pyright: boolean;
    react: boolean;
    reactNative: boolean;
    semanticRelease: boolean;
    storybook: boolean;
    tauri: boolean;
    vinext: boolean;
    vite: boolean;
    wb: boolean;
    chakra: boolean;
    drizzle: boolean;
  };
  release: {
    branches: string[];
    github: boolean;
    npm: boolean;
  };
  miseTasks: Record<string, string>;
  packageJson?: PackageJson;
  wbfyJson?: WbfyJson;
}

type WbfyJson = z.infer<typeof wbfyJsonSchema>;

const wbfyJsonSchema = z.object({
  typos: z
    .object({
      all: z.record(z.string(), z.string()).optional(),
      doc: z.record(z.string(), z.string()).optional(),
      ts: z.record(z.string(), z.string()).optional(),
      text: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

export async function getPackageConfig(
  dirPath: string,
  options?: { isRoot?: boolean }
): Promise<PackageConfig | undefined> {
  const packageJsonPath = path.resolve(dirPath, 'package.json');
  try {
    const doesContainPackageJson = fs.existsSync(packageJsonPath);
    let dependencies: PackageJson['dependencies'] = {};
    let devDependencies: PackageJson['devDependencies'] = {};
    let packageJson: PackageJson = {};
    let esmPackage = false;
    if (doesContainPackageJson) {
      const packageJsonText = fs.readFileSync(packageJsonPath, 'utf8');
      packageJson = JSON.parse(packageJsonText) as PackageJson;
      dependencies = packageJson.dependencies ?? {};
      devDependencies = packageJson.devDependencies ?? {};
      esmPackage = packageJson.type === 'module';
    }

    let releaseBranches: string[] = [];
    let releasePlugins: string[] = [];
    try {
      const releasercJsonPath = path.resolve(dirPath, '.releaserc.json');
      const json = JSON.parse(await fsp.readFile(releasercJsonPath, 'utf8')) as
        | {
            branches: string[];
            plugins?: string[][];
          }
        | undefined;
      releaseBranches = json?.branches ?? [];
      releasePlugins = json?.plugins?.flat() ?? [];
    } catch {
      // do nothing
    }

    // The caller may classify explicitly (index.ts passes false for every discovered workspace,
    // including non-packages/* layouts such as apps/*); the packages/* heuristic classifies the
    // CLI entry path itself, so `wbfy <repo>/packages/<app>` keeps its child classification.
    const isRoot =
      options?.isRoot ??
      (path.basename(path.resolve(dirPath, '..')) !== 'packages' ||
        !fs.existsSync(path.resolve(dirPath, '..', '..', 'package.json')));

    let repoInfo: Record<string, unknown> | undefined;
    if (isRoot) {
      repoInfo = await fetchRepoInfo(dirPath, packageJson);
    }

    let dockerfile = '';
    try {
      dockerfile = await fsp.readFile(path.resolve(dirPath, 'Dockerfile'), 'utf8');
    } catch {
      // do nothing
    }

    // Read wbfy.json
    const wbfyJsonPath = path.resolve(dirPath, 'wbfy.json');
    let wbfyJson: WbfyJson | undefined;
    try {
      const wbfyJsonText = await fsp.readFile(wbfyJsonPath, 'utf8');
      wbfyJson = wbfyJsonSchema.parse(JSON.parse(wbfyJsonText));
    } catch {
      // do nothing
    }

    const repoFullName = typeof repoInfo?.full_name === 'string' ? repoInfo.full_name : undefined;
    let repoAuthor: string | undefined;
    let repoName: string | undefined;
    if (repoFullName) {
      const repoParts = repoFullName.split('/');
      if (repoParts.length >= 2) {
        repoAuthor = repoParts[0];
        repoName = repoParts[1];
      }
    }
    const repository = repoFullName ? `github:${repoFullName}` : undefined;
    // Tauri officially supports JSON, JSON5, and TOML configuration formats.
    const doesContainTauriConfig = ['tauri.conf.json', 'tauri.conf.json5', 'Tauri.toml'].some((fileName) =>
      fs.existsSync(path.resolve(dirPath, 'src-tauri', fileName))
    );
    const config: PackageConfig = {
      dirPath,
      dockerfile,
      isRoot,
      isPublicRepo: repoInfo?.private === false,
      isReferredByOtherRepo: !!packageJson.files,
      repository,
      repoAuthor,
      repoName,
      isWillBoosterRepo: Boolean(
        repository?.startsWith('github:WillBooster/') || repository?.startsWith('github:WillBoosterLab/')
      ),
      isCloudflare: detectCloudflare(dirPath, packageJson),
      doesContainWranglerConfig: detectWranglerConfig(dirPath),
      isRailway: detectRailway(dirPath, packageJson),
      isEsmPackage: esmPackage,
      isWillBoosterConfigs: packageJsonPath.includes('/willbooster-configs'),
      cargoTomlDirPaths: findCargoTomlDirPaths(dirPath),
      // Also honor declared workspace patterns beyond packages/* (e.g. apps/*): treating an
      // apps/*-only monorepo as a plain package would delete its `workspaces` declaration in
      // generatePackageJson and skip monorepo-only conventions such as root `private: true`.
      doesContainSubPackageJsons:
        containsAny('packages/**/package.json', dirPath) ||
        getWorkspacePackageJsonPaths({ dirPath, packageJson, doesContainSubPackageJsons: false }).length > 0,
      doesContainDockerfile: !!dockerfile || fs.existsSync(path.resolve(dirPath, 'docker-compose.yml')),
      doesContainGemfile: fs.existsSync(path.resolve(dirPath, 'Gemfile')),
      doesContainGoMod: fs.existsSync(path.resolve(dirPath, 'go.mod')),
      doesContainPackageJson: fs.existsSync(path.resolve(dirPath, 'package.json')),
      doesContainPoetryLock: fs.existsSync(path.resolve(dirPath, 'poetry.lock')),
      doesContainUvLock: fs.existsSync(path.resolve(dirPath, 'uv.lock')),
      doesContainPomXml: fs.existsSync(path.resolve(dirPath, 'pom.xml')),
      doesContainPubspecYaml: fs.existsSync(path.resolve(dirPath, 'pubspec.yaml')),
      doesContainTauriConfig,
      doesContainTauriConfigInPackages: containsAny(
        'packages/**/src-tauri/{tauri.conf.json,tauri.conf.json5,Tauri.toml}',
        dirPath
      ),
      doesContainTemplateYaml: fs.existsSync(path.resolve(dirPath, 'template.yaml')),
      doesContainVscodeSettingsJson: fs.existsSync(path.resolve(dirPath, '.vscode', 'settings.json')),
      doesContainJavaScript: containsAny('{app,src,test,scripts}/**/*.{cjs,mjs,js,jsx}', dirPath),
      doesContainTypeScript: containsAny('{app,src,test,scripts}/**/*.{cts,mts,ts,tsx}', dirPath),
      doesContainJsxOrTsx: containsAny('{app,src,test}/**/*.{t,j}sx', dirPath),
      doesContainJava: containsAny('**/*.java', dirPath),
      doesContainJavaScriptInPackages: containsAny('packages/**/{app,src,test,scripts}/**/*.{cjs,mjs,js,jsx}', dirPath),
      doesContainTypeScriptInPackages: containsAny('packages/**/{app,src,test,scripts}/**/*.{cts,mts,ts,tsx}', dirPath),
      doesContainJsxOrTsxInPackages: containsAny('packages/**/{app,src,test}/**/*.{t,j}sx', dirPath),
      doesContainJavaInPackages: containsAny('packages/**/*.java', dirPath),
      depending: {
        blitz: !!dependencies.blitz,
        chakra: !!devDependencies['@chakra-ui/cli'],
        drizzle: !!dependencies['drizzle-orm'] || !!devDependencies['drizzle-kit'],
        firebase: !!devDependencies['firebase-tools'],
        genI18nTs: !!dependencies['gen-i18n-ts'] || !!devDependencies['gen-i18n-ts'],
        litestream: dockerfile.includes('install-litestream.sh'),
        react: !!dependencies.react,
        next: !!dependencies.next,
        playwrightTest:
          !!dependencies['@playwright/test'] || !!devDependencies['@playwright/test'] || !!devDependencies.playwright,
        playwrightRuntime: doesImportPlaywrightAtRuntime(dirPath),
        prisma: !!dependencies['@prisma/client'] || !!devDependencies.prisma,
        pyright: !!devDependencies.pyright,
        reactNative: !!dependencies['react-native'],
        semanticRelease: !!(
          devDependencies['semantic-release'] ||
          releaseBranches.length > 0 ||
          releasePlugins.length > 0
        ),
        storybook: !!devDependencies['@storybook/react'],
        tauri:
          !!dependencies['@tauri-apps/api'] ||
          !!devDependencies['@tauri-apps/api'] ||
          !!dependencies['@tauri-apps/cli'] ||
          !!devDependencies['@tauri-apps/cli'] ||
          doesContainTauriConfig,
        vinext: !!dependencies.vinext || !!devDependencies.vinext,
        vite: !!dependencies.vite || !!devDependencies.vite,
        wb: !!dependencies['@willbooster/wb'] || !!devDependencies['@willbooster/wb'],
      },
      release: {
        branches: releaseBranches,
        github: releasePlugins.includes('@semantic-release/github'),
        npm: releasePlugins.includes('@semantic-release/npm'),
      },
      miseTasks: await readMiseTasks(dirPath),
      packageJson,
      wbfyJson,
    };
    if (
      config.doesContainGemfile ||
      config.doesContainGoMod ||
      config.doesContainPackageJson ||
      config.doesContainPoetryLock ||
      config.doesContainUvLock ||
      config.doesContainPomXml ||
      config.doesContainPubspecYaml ||
      config.doesContainTauriConfig ||
      config.doesContainTemplateYaml
    ) {
      return config;
    }
  } catch {
    // do nothing
  }
}

/**
 * Tells whether wbfy manages worker-configuration.d.ts for the package. The file is gitignored and untracked on the
 * assumption that `wrangler types` regenerates it on install, so all three steps must agree: the package has to own a
 * wrangler config (`wrangler types` exits non-zero without one), to depend on wrangler (a package deploying via a
 * CI action cannot resolve the command), and to regenerate the same file on every checkout. Otherwise wbfy would
 * ignore and delete a file that nothing recreates identically.
 */
export function generatesWorkerTypes(config: PackageConfig): boolean {
  const packageJson = config.packageJson;
  return (
    config.doesContainWranglerConfig &&
    Boolean(packageJson?.dependencies?.['wrangler'] || packageJson?.devDependencies?.['wrangler']) &&
    // A project invocation that writes the managed default file from inputs wbfy cannot validate (e.g.
    // `wrangler types -c wrangler.jsonc -c ../bound-worker/wrangler.jsonc` for RPC types) would fight a managed
    // fallback generator over the same file, and several distinct flagged generators leave no deterministic
    // choice, so such packages stay unmanaged.
    !selectProjectWranglerTypesGenerator(packageJson?.scripts ?? {}).conflicting &&
    consumesGeneratedWorkerTypes(config) &&
    hasReproducibleWorkerTypesInference(config)
  );
}

/**
 * A package whose TypeScript project cannot include worker-configuration.d.ts (e.g. one on a hand-maintained
 * minimal `Env` with `types: ["bun"]`, the standard escape when the ambient wrangler globals conflict with the
 * `@types/bun` globals its tests need) gains nothing from regenerating the ~500KB file on every install, so wbfy
 * leaves such packages unmanaged instead of re-adding the generation step. Consumption is detected two ways:
 * a textual `worker-configuration` reference in any tracked file of the package (covers imports, triple-slash
 * references, and explicit tsconfig entries), or a `files`/`include`/`exclude` set that can match the file —
 * resolved through relative `extends` chains with each pattern kept relative to the config that declared it,
 * matching tsc. Whenever the effective set cannot be determined (missing or unparseable tsconfig, package-name
 * `extends` presets, or TypeScript's default `**` inclusion), the current managed behavior is kept.
 */
export function consumesGeneratedWorkerTypes(config: Pick<PackageConfig, 'dirPath'>): boolean {
  // `git grep` searches tracked files only, so the gitignored generated file itself never matches.
  // wbfy's own managed artifacts are excluded: the `.gitignore` rule (`/worker-configuration.d.ts`)
  // wbfy committed while it managed the package must not count as consumption, or a once-managed
  // package could never opt out.
  const grepResult = spawnSyncAndReturnStdout(
    'git',
    // tsconfig files are classified by the resolved files/include/exclude logic below — a textual
    // hit there (e.g. an `exclude` entry) must not count as consumption.
    [
      'grep',
      '-l',
      'worker-configuration',
      '--',
      '.',
      ':(exclude).gitignore',
      ':(exclude).gitattributes',
      String.raw`:(glob,exclude)**/tsconfig*.json`,
    ],
    config.dirPath
  );
  if (grepResult.trim()) return true;

  const workerTypesPath = path.resolve(config.dirPath, 'worker-configuration.d.ts');
  const fileSet = resolveTsconfigFileSet(path.resolve(config.dirPath, 'tsconfig.json'), config.dirPath, 5);
  if (!fileSet) return true;
  const matches = (patternSet: TsconfigPatternSet | undefined): boolean => {
    if (!patternSet || !Array.isArray(patternSet.patterns)) return false;
    const relativePath = path.relative(patternSet.baseDirPath, workerTypesPath).replaceAll('\\', '/');
    return patternSet.patterns.some((pattern) => {
      if (typeof pattern !== 'string') return false;
      // `${configDir}`-prefixed patterns were expanded to absolute paths at resolve time.
      if (path.isAbsolute(pattern)) {
        return tsconfigPatternCouldMatchPath(pattern, workerTypesPath, patternSet.expandsDirectories);
      }
      if (relativePath.startsWith('..')) return false;
      return tsconfigPatternCouldMatchPath(pattern, relativePath, patternSet.expandsDirectories);
    });
  };
  // `files` entries are always part of the program, even when `exclude` matches them.
  if (matches(fileSet.files)) return true;
  if (matches(fileSet.exclude)) return false;
  // Neither include nor files declared: TypeScript's default `**` inclusion covers the file.
  if (!fileSet.include && !fileSet.files) return true;
  return matches(fileSet.include);
}

interface TsconfigPatternSet {
  /** Directory of the config that declared the patterns; tsc resolves them relative to it. */
  baseDirPath: string;
  /** include/exclude treat an extensionless non-glob pattern as a directory subtree; `files` does not. */
  expandsDirectories: boolean;
  patterns: unknown;
}

interface TsconfigFileSet {
  exclude?: TsconfigPatternSet;
  files?: TsconfigPatternSet;
  include?: TsconfigPatternSet;
}

/** Resolves files/include/exclude through relative `extends` chains; undefined when unreadable. */
function resolveTsconfigFileSet(
  filePath: string,
  consumerDirPath: string,
  remainingDepth: number
): TsconfigFileSet | undefined {
  if (remainingDepth <= 0) return undefined;
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  const tsconfig = jsoncUtil.parseObjectIgnoringError<{
    exclude?: unknown;
    extends?: unknown;
    files?: unknown;
    include?: unknown;
  }>(content);
  if (!tsconfig) return undefined;
  const dirPath = path.dirname(filePath);
  // `${configDir}` resolves to the directory of the ROOT (consuming) config, wherever it appears.
  const toPatternSet = (patterns: unknown, expandsDirectories: boolean): TsconfigPatternSet | undefined =>
    Array.isArray(patterns)
      ? {
          baseDirPath: dirPath,
          expandsDirectories,
          patterns: patterns.map((pattern) =>
            typeof pattern === 'string' && pattern.startsWith('${configDir}')
              ? path.join(consumerDirPath, pattern.slice('${configDir}'.length))
              : pattern
          ),
        }
      : undefined;
  const fileSet: TsconfigFileSet = {
    exclude: toPatternSet(tsconfig.exclude, true),
    files: toPatternSet(tsconfig.files, false),
    include: toPatternSet(tsconfig.include, true),
  };
  const parents =
    typeof tsconfig.extends === 'string' ? [tsconfig.extends] : Array.isArray(tsconfig.extends) ? tsconfig.extends : [];
  // With an `extends` array, later entries override earlier ones, and the child overrides all —
  // so fill each still-missing key from the last parent that defines it.
  for (const parent of parents.toReversed()) {
    if (fileSet.exclude && fileSet.files && fileSet.include) break;
    // Package-name extends (e.g. `@tsconfig/bun`) are compilerOptions presets without file sets.
    if (typeof parent !== 'string' || !parent.startsWith('.')) continue;
    let parentPath = path.resolve(dirPath, parent);
    if (!fs.existsSync(parentPath) && fs.existsSync(`${parentPath}.json`)) parentPath += '.json';
    const parentFileSet = resolveTsconfigFileSet(parentPath, consumerDirPath, remainingDepth - 1);
    if (!parentFileSet) continue;
    fileSet.exclude ??= parentFileSet.exclude;
    fileSet.files ??= parentFileSet.files;
    fileSet.include ??= parentFileSet.include;
  }
  return fileSet;
}

function tsconfigPatternCouldMatchPath(pattern: string, targetPath: string, expandsDirectories: boolean): boolean {
  const normalized = pattern.replace(/^\.\//u, '');
  // A bare `.` include covers everything under the config's directory.
  if (normalized === '' || normalized === '.') return true;
  // Absolute patterns (expanded `${configDir}`) are matched against the absolute target; drop the
  // leading slashes from both so the segment-built regex anchors identically.
  targetPath = targetPath.replace(/^\/+/u, '');
  const segments = normalized.split('/').filter((segment) => segment !== '');
  const regexSource = segments
    .map((segment, index) => {
      const isLast = index === segments.length - 1;
      if (segment === '**') return isLast ? '.*' : String.raw`(?:[^/]+/)*`;
      const segmentSource = segment
        .replaceAll(/[.+^${}()|[\]\\]/gu, String.raw`\$&`)
        .replaceAll('*', String.raw`[^/]*`)
        .replaceAll('?', String.raw`[^/]`);
      return isLast ? segmentSource : `${segmentSource}/`;
    })
    .join('');
  // tsc treats an extensionless non-glob include/exclude entry as a directory whose subtree is included.
  const lastSegment = segments.at(-1) ?? '';
  const directorySuffix =
    expandsDirectories && !/[*?]/u.test(lastSegment) && !lastSegment.includes('.') ? String.raw`(?:/.*)?` : '';
  return new RegExp(`^${regexSource}${directorySuffix}$`, 'u').test(targetPath);
}

/**
 * `wrangler types` infers `Env` members from the .dev.vars/.env files beside the wrangler config — including the
 * layered variants wrangler resolves, such as .env.local and environment-specific files — unless the config
 * declares `secrets.required`. Untracking worker-configuration.d.ts is safe only when every such input is
 * identical on every checkout: with a gitignored or locally modified file, CI would regenerate an `Env` without
 * the secret members that type-check locally.
 */
function hasReproducibleWorkerTypesInference(config: PackageConfig): boolean {
  const dirPath = config.dirPath;
  // With a secrets declaration, `wrangler types` reads only the wrangler config, so a missing or
  // stale config on CI fails the generation LOUDLY instead of silently inferring a wrong Env; the
  // tracked-clean checks below guard only the silent-drift hazard of the dotenv-inference path.
  if (declaresSupportedRequiredSecrets(config)) return true;
  // The wrangler config itself drives the generation, so an untracked, modified, or symlinked config makes the
  // generated file irreproducible whatever the dotenv inputs say.
  const configFileNames = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].filter((fileName) =>
    fs.existsSync(path.resolve(dirPath, fileName))
  );
  if (!areTrackedCleanRegularFiles(dirPath, configFileNames)) return false;
  const inferenceSourceNames = fs
    .readdirSync(dirPath)
    .filter((fileName) => /^\.(?:dev\.vars|env)(?:\..+)?$/u.test(fileName));
  return areTrackedCleanRegularFiles(dirPath, inferenceSourceNames);
}

/**
 * Whether every listed file is a regular file (a tracked symlink's git state says nothing about its target's
 * content), tracked, AND unmodified: `git ls-files` prints nothing for an untracked file (and fails printing
 * nothing outside a repository), while `git status --porcelain` prints nothing for a clean file — wrangler reads
 * the working tree, but CI reads the committed contents, so local edits break reproducibility too. (An ignored
 * file also produces empty status output, which the tracked check catches.)
 */
function areTrackedCleanRegularFiles(dirPath: string, fileNames: string[]): boolean {
  if (fileNames.length === 0) return true;
  if (fileNames.some((fileName) => fs.lstatSync(path.resolve(dirPath, fileName)).isSymbolicLink())) return false;
  const trackedOutput = spawnSyncAndReturnStdout('git', ['ls-files', '--', ...fileNames], dirPath);
  const trackedCount = trackedOutput === '' ? 0 : trackedOutput.split('\n').length;
  return (
    trackedCount === fileNames.length &&
    spawnSyncAndReturnStdout('git', ['status', '--porcelain', '--', ...fileNames], dirPath) === ''
  );
}

// `wrangler types` generates from `secrets.required` since wrangler 4.70.0 (4.77.0 only added deploy/upload
// validation of the field); older wranglers warn about the unexpected field and keep inferring from .dev.vars.
const minimumWranglerVersionForRequiredSecrets = '4.70.0';

function declaresSupportedRequiredSecrets(config: PackageConfig): boolean {
  const wranglerVersionRange =
    config.packageJson?.dependencies?.['wrangler'] ?? config.packageJson?.devDependencies?.['wrangler'];
  if (!wranglerVersionRange) return false;
  try {
    const minimumVersion = semver.minVersion(wranglerVersionRange);
    if (!minimumVersion || semver.lt(minimumVersion, minimumWranglerVersionForRequiredSecrets)) return false;
  } catch {
    return false;
  }
  return wranglerConfigDeclaresRequiredSecrets(config.dirPath);
}

interface WranglerConfigSecretsSubtree {
  secrets?: { required?: string[] };
  env?: Record<string, { secrets?: { required?: string[] } } | undefined>;
}

function wranglerConfigDeclaresRequiredSecrets(dirPath: string): boolean {
  try {
    for (const fileName of ['wrangler.jsonc', 'wrangler.json']) {
      const filePath = path.resolve(dirPath, fileName);
      if (!fs.existsSync(filePath)) continue;
      // A config that does not parse cannot prove a declaration.
      const config = jsoncUtil.parseObjectIgnoringError<WranglerConfigSecretsSubtree>(
        fs.readFileSync(filePath, 'utf8')
      );
      return !!config && declaresRequiredSecretsAnywhere(config);
    }
    const tomlPath = path.resolve(dirPath, 'wrangler.toml');
    if (fs.existsSync(tomlPath)) {
      const config = parseToml(fs.readFileSync(tomlPath, 'utf8')) as WranglerConfigSecretsSubtree;
      return declaresRequiredSecretsAnywhere(config);
    }
  } catch {
    // A config that does not parse cannot prove a declaration.
  }
  return false;
}

// A declaration at any config level replaces the .dev.vars/.env inference: `wrangler types` aggregates
// per-environment secrets into the generated type (Cloudflare changelog 2026-03-24).
function declaresRequiredSecretsAnywhere(config: WranglerConfigSecretsSubtree): boolean {
  if (declaresSecrets(config.secrets)) return true;
  return Object.values(config.env ?? {}).some((envConfig) => declaresSecrets(envConfig?.secrets));
}

// Defining `secrets` at any config level makes `wrangler types` use it exclusively instead of
// inferring from .dev.vars/.env, so even an empty declaration is reproducible. The parsed config
// comes from an unvalidated file, so check the documented `string[]` shape at runtime: a malformed
// declaration (e.g. a plain string) must not prove reproducibility.
function declaresSecrets(secrets: WranglerConfigSecretsSubtree['secrets']): boolean {
  if (secrets === undefined || secrets === null || typeof secrets !== 'object' || Array.isArray(secrets)) return false;
  const required: unknown = secrets.required;
  return required === undefined || (Array.isArray(required) && required.every((name) => typeof name === 'string'));
}

/**
 * Tells whether the directory owns a Worker, unlike the isCloudflare heuristic, which also matches a package that
 * merely mentions wrangler in a script or workflow (e.g. the root of a monorepo whose Worker lives in a sub-package).
 */
export function detectWranglerConfig(dirPath: string): boolean {
  return ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((fileName) =>
    fs.existsSync(path.resolve(dirPath, fileName))
  );
}

function detectCloudflare(dirPath: string, packageJson: PackageJson): boolean {
  const scripts = packageJson.scripts;
  if (scripts && Object.values(scripts).some((script) => typeof script === 'string' && script.includes('wrangler'))) {
    return true;
  }

  if (detectWranglerConfig(dirPath)) {
    return true;
  }

  return workflowFilesMatch(dirPath, /cloudflare|wrangler/iu);
}

function detectRailway(dirPath: string, packageJson: PackageJson): boolean {
  const scripts = packageJson.scripts;
  if (scripts && Object.values(scripts).some((script) => typeof script === 'string' && script.includes('railway'))) {
    return true;
  }

  if (fs.existsSync(path.resolve(dirPath, '.railwayignore')) || fs.existsSync(path.resolve(dirPath, 'railway.json'))) {
    return true;
  }

  return workflowFilesMatch(dirPath, /railway/iu);
}

function workflowFilesMatch(dirPath: string, regex: RegExp): boolean {
  const workflowsPath = path.resolve(dirPath, '.github', 'workflows');
  try {
    return fs
      .readdirSync(workflowsPath)
      .some((fileName) => /\.ya?ml$/iu.test(fileName) && workflowFileMatches(workflowsPath, fileName, regex));
  } catch {
    return false;
  }
}

function workflowFileMatches(workflowsPath: string, fileName: string, regex: RegExp): boolean {
  try {
    return regex.test(fs.readFileSync(path.join(workflowsPath, fileName), 'utf8'));
  } catch {
    return false;
  }
}

async function readMiseTasks(dirPath: string): Promise<Record<string, string>> {
  const tasks: Record<string, string> = {};
  for (const fileName of ['mise.toml', '.mise.toml']) {
    const filePath = path.resolve(dirPath, fileName);
    try {
      const settings = parseToml(await fsp.readFile(filePath, 'utf8')) as { tasks?: Record<string, unknown> };
      for (const [name, value] of Object.entries(settings.tasks ?? {})) {
        tasks[name] = readMiseTaskCommand(value);
      }
    } catch {
      // Missing or temporarily invalid mise files should not block other wbfy generators.
    }
  }
  return tasks;
}

function readMiseTaskCommand(value: unknown): string {
  if (typeof value === 'string') return value;
  // Preserve array-form mise commands so recursion checks can still see package script calls.
  if (Array.isArray(value)) return value.filter((command): command is string => typeof command === 'string').join('\n');
  if (value && typeof value === 'object') return readMiseTaskCommand((value as { run?: unknown }).run);
  return '';
}

function containsAny(pattern: string, dirPath: string): boolean {
  return fg.globSync(pattern, { dot: true, cwd: dirPath, ignore: globIgnore }).length > 0;
}

function findCargoTomlDirPaths(dirPath: string): string[] {
  return fg
    .globSync('**/Cargo.toml', { dot: true, cwd: dirPath, ignore: globIgnore })
    .map((filePath) => path.dirname(filePath))
    .toSorted((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function doesImportPlaywrightAtRuntime(dirPath: string): boolean {
  const files = fg.globSync('{app,src}/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}', {
    dot: true,
    cwd: dirPath,
    ignore: [...globIgnore, '**/__tests__/**', '**/*.spec.*', '**/*.test.*', '**/playwright.config.*'],
  });
  return files.some((file) => {
    const content = fs.readFileSync(path.resolve(dirPath, file), 'utf8');
    return /\bfrom\s+['"]playwright['"]|\bimport\s*\(\s*['"]playwright['"]\s*\)|\brequire\s*\(\s*['"]playwright['"]\s*\)/u.test(
      content
    );
  });
}

async function fetchRepoInfo(dirPath: string, packageJson: PackageJson): Promise<Record<string, unknown> | undefined> {
  const git = simpleGit(dirPath);
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === 'origin');
  const remoteUrl = origin?.refs.fetch ?? origin?.refs.push;
  if (typeof remoteUrl === 'string') {
    const json = await requestRepoInfo(remoteUrl);
    if (json) return json;
  }

  const url = typeof packageJson.repository === 'string' ? packageJson.repository : packageJson.repository?.url;
  if (url) {
    const json = await requestRepoInfo(url);
    if (json && json.message !== 'Not Found') return json;
  }
}

async function requestRepoInfo(urlOrFullName: string): Promise<Record<string, unknown> | undefined> {
  const [org, name] = gitHubUtil.getOrgAndName(urlOrFullName);
  if (!org || !name) return;

  try {
    // Metadata permission
    const response = await getOctokit().request('GET /repos/{owner}/{repo}', {
      owner: org,
      repo: name,
    });
    return response.data;
  } catch (error) {
    const redirectedFullName = getRedirectedRepoFullName(error);
    if (redirectedFullName) {
      return { full_name: redirectedFullName };
    }
  }
}

function getRedirectedRepoFullName(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return;

  const response =
    'response' in error
      ? (error as { response?: { status?: number; headers?: Record<string, string | undefined> } }).response
      : undefined;
  const status = response?.status ?? (error as { status?: number }).status;
  if (status !== 301 && status !== 302) return;

  const location = response?.headers?.location;
  if (typeof location !== 'string') return;

  const [org, name] = gitHubUtil.getOrgAndName(location);
  if (!org || !name) return;

  return `${org}/${name}`;
}
