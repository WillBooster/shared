import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';
import { simpleGit } from 'simple-git';
import { parse as parseToml } from 'smol-toml';
import type { PackageJson } from 'type-fest';
import { z } from 'zod';

import { getOctokit, gitHubUtil } from './utils/githubUtil.js';
import { globIgnore } from './utils/globUtil.js';
import { jsoncUtil } from './utils/jsoncUtil.js';
import { spawnSyncAndReturnStdout } from './utils/spawnUtil.js';
import { escapeRegExp } from './utils/stringUtil.js';
import { classifyScriptSegment, splitScriptSegments } from './utils/managedScriptSegment.js';
import {
  getDeclaredWorkspacePatterns,
  getWorkspacePackageJsonPaths,
  getWorkspaceSubDirPaths,
} from './utils/workspaceUtil.js';

export interface PackageConfig {
  dirPath: string;
  dockerfile: string;
  isRoot: boolean;
  isPublicRepo: boolean;
  // Whether isPublicRepo comes from an actual GitHub API response: a failed lookup (offline,
  // rate-limited, bad credential) collapses to isPublicRepo=false, which visibility-sensitive
  // generators must not mistake for a confirmed private repository.
  isRepoVisibilityKnown: boolean;
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
  /** Whether a Python lockfile (poetry.lock / uv.lock) exists anywhere in the directory tree. */
  doesContainPythonLockAnywhere: boolean;
  doesContainPomXml: boolean;
  /** Whether a Maven pom.xml exists anywhere in the directory tree. */
  doesContainPomXmlAnywhere: boolean;
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
    prettierRuntime: boolean;
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
    /**
     * An explicit `@semantic-release/npm` plugin entry publishes the root manifest itself
     * (no pkgRoot redirection and npmPublish not disabled).
     */
    npmPublishesRoot: boolean;
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

/**
 * The semantic-release config files wbfy expects, in cosmiconfig's resolution order (the leading
 * package.json entry is checked by the caller). wbfy generates .releaserc.json; the other spellings
 * are listed only to detect a hand-written config, whose format JSON.parse cannot read and whose
 * plugin list is therefore statically uninspectable.
 */
const semanticReleaseConfigSearchPlaces: { fileName: string; jsonParseable: boolean }[] = [
  { fileName: '.releaserc', jsonParseable: true },
  { fileName: '.releaserc.json', jsonParseable: true },
  { fileName: '.releaserc.yaml', jsonParseable: false },
  { fileName: '.releaserc.yml', jsonParseable: false },
  { fileName: '.releaserc.js', jsonParseable: false },
  { fileName: 'release.config.js', jsonParseable: false },
];

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
    let releasePluginsAreExplicit = false;
    let releaseNpmPluginPublishesRoot = false;
    // The FIRST existing search place wins (cosmiconfig short-circuits), so a JS/YAML/TS config
    // or an `extends` preset makes the effective plugin list statically uninspectable (mirrors
    // readExplicitSemanticReleasePlugins in wb's release.ts). Treating it as unknown keeps
    // `release.npm` conservatively true, so applyPackageJsonConventions never forces
    // `private: true` on a monorepo that actually publishes to npm.
    let releasePluginsAreUnknown = false;
    try {
      type ReleaseConfig =
        | {
            branches?: unknown;
            plugins?: (string | [string, Record<string, unknown>])[];
            extends?: unknown;
          }
        | undefined;
      // cosmiconfig searches package.json's `release` key BEFORE any rc/config file
      // (semantic-release 25 delegates to cosmiconfig 9's default searchPlaces).
      let releaseConfig = (packageJson as { release?: ReleaseConfig }).release;
      if (releaseConfig === undefined) {
        for (const { fileName, jsonParseable } of semanticReleaseConfigSearchPlaces) {
          const releasercPath = path.resolve(dirPath, fileName);
          if (!fs.existsSync(releasercPath)) continue;
          if (!jsonParseable) {
            releasePluginsAreUnknown = true;
            break;
          }
          // `.releaserc` and `.config/releaserc` may also hold YAML; a JSON.parse failure lands
          // in the catch below and marks the plugin list unknown instead of silently reporting
          // "no plugins".
          releaseConfig = JSON.parse(await fsp.readFile(releasercPath, 'utf8')) as ReleaseConfig;
          break;
        }
      }
      // semantic-release accepts a scalar branch or branch objects ({ name, prerelease, ... });
      // normalize to plain branch names for consumers such as the workflow generator.
      const rawBranches = releaseConfig?.branches;
      releaseBranches = (Array.isArray(rawBranches) ? rawBranches : rawBranches === undefined ? [] : [rawBranches])
        .map((branch: unknown) =>
          typeof branch === 'string' ? branch : (branch as { name?: unknown } | undefined)?.name
        )
        .filter((branchName): branchName is string => typeof branchName === 'string');
      if (Array.isArray(releaseConfig?.plugins)) {
        releasePluginsAreExplicit = true;
        for (const pluginEntry of releaseConfig.plugins) {
          const [pluginName, pluginOptions] = Array.isArray(pluginEntry) ? pluginEntry : [pluginEntry, undefined];
          if (typeof pluginName !== 'string') continue;
          releasePlugins.push(pluginName);
          if (pluginName !== '@semantic-release/npm') continue;
          // With pkgRoot the plugin publishes another manifest (it resolves pkgRoot against the
          // repo root, so `.` and `./` both mean the root itself), and npmPublish: false
          // disables publishing entirely; only the remaining shape proves the ROOT is published.
          const pkgRoot = pluginOptions?.pkgRoot;
          const publishesRoot =
            pluginOptions?.npmPublish !== false &&
            (pkgRoot === undefined ||
              (typeof pkgRoot === 'string' && path.resolve(dirPath, pkgRoot) === path.resolve(dirPath)));
          releaseNpmPluginPublishesRoot ||= publishesRoot;
        }
      } else if (releaseConfig && releaseConfig.extends !== undefined) {
        releasePluginsAreUnknown = true;
      }
    } catch {
      releasePluginsAreUnknown = true;
    }
    // Without an explicit plugin list, semantic-release's default list applies, which includes
    // @semantic-release/npm and @semantic-release/github (mirrors releasePublishesToNpm in wb's
    // release.ts).
    const usesSemanticRelease = !!(
      devDependencies['semantic-release'] ||
      releaseBranches.length > 0 ||
      releasePlugins.length > 0 ||
      releasePluginsAreUnknown
    );

    // The caller may classify explicitly (index.ts passes false for every discovered workspace,
    // including non-packages/* layouts such as apps/*); the heuristic classifies the CLI entry
    // path itself, so `wbfy <repo>/packages/<app>` and `wbfy <repo>/apps/<app>` keep their child
    // classification.
    const isRoot = options?.isRoot ?? !isWorkspaceOfEnclosingRoot(dirPath);

    let repoInfo: Record<string, unknown> | undefined;
    // Fetch visibility for the CLI entry even when it is a workspace child (`wbfy
    // <repo>/packages/<app>`): generators read isPublicRepo from their rootConfig parameter,
    // which IS the child config in that invocation, so a stub `false` there would drop the
    // public-repo publishConfig handling. Discovered children (options.isRoot === false) still
    // skip the fetch — they inherit the enclosing root's visibility via rootConfig instead.
    if (options?.isRoot !== false) {
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
    // Only the root fetches repo info, and that fetch needs network and a token, so identity-derived
    // flags below would otherwise be false for every workspace package and for every offline or
    // rate-limited run. The git remote answers the same question locally, for every package.
    if (!repoAuthor || !repoName) {
      [repoAuthor, repoName] = await resolveLocalRepoIdentity(dirPath, packageJson);
    }
    // Built from the RESOLVED identity so workspace packages and offline runs also get it; consumers derive
    // the owner from this field (e.g. to set `author`).
    const repository = repoAuthor && repoName ? `github:${repoAuthor}/${repoName}` : undefined;
    // Tauri officially supports JSON, JSON5, and TOML configuration formats.
    const doesContainTauriConfig = ['tauri.conf.json', 'tauri.conf.json5', 'Tauri.toml'].some((fileName) =>
      fs.existsSync(path.resolve(dirPath, 'src-tauri', fileName))
    );
    // Root-level "InPackages" signals must see every DECLARED workspace layout (e.g. apps/*), not
    // just the conventional packages/* directory, so scan each discovered workspace directory.
    // The packages/* fallback is routed through discovery's combined glob so declared negations
    // (e.g. `!packages/excluded`) exclude a package from the signals too; the broad packages/**
    // scan remains only for legacy repos with no `workspaces` declaration at all (wbfy adds the
    // declaration only on a later generator pass), where discovery has nothing to honor.
    const declaredWorkspacePatterns = getDeclaredWorkspacePatterns(packageJson.workspaces);
    const workspaceSubDirPaths = getWorkspaceSubDirPaths({
      dirPath,
      packageJson,
      doesContainSubPackageJsons: containsAny('packages/*/package.json', dirPath),
    });
    const containsAnyInWorkspaces = (pattern: string): boolean =>
      workspaceSubDirPaths.some((workspaceSubDirPath) => containsAny(pattern, workspaceSubDirPath)) ||
      (declaredWorkspacePatterns.length === 0 && containsAny(`packages/**/${pattern}`, dirPath));
    const doesContainWranglerConfig = detectWranglerConfig(dirPath);
    const workflowContents = readWorkflowFileContents(dirPath);
    const runtimeImports = detectRuntimeImports(dirPath);
    const config: PackageConfig = {
      dirPath,
      dockerfile,
      isRoot,
      isPublicRepo: repoInfo?.private === false,
      isRepoVisibilityKnown: typeof repoInfo?.private === 'boolean',
      isReferredByOtherRepo: !!packageJson.files,
      repository,
      repoAuthor,
      repoName,
      isWillBoosterRepo: Boolean(
        repository?.startsWith('github:WillBooster/') || repository?.startsWith('github:WillBoosterLab/')
      ),
      isCloudflare: detectCloudflare(packageJson, doesContainWranglerConfig, workflowContents),
      doesContainWranglerConfig,
      isRailway: detectRailway(dirPath, packageJson, workflowContents),
      isEsmPackage: esmPackage,
      isWillBoosterConfigs: detectIsWillBoosterConfigs(dirPath, packageJsonPath, repoName),
      cargoTomlDirPaths: findCargoTomlDirPaths(dirPath),
      // Also honor declared workspace patterns beyond packages/* (e.g. apps/*): treating an
      // apps/*-only monorepo as a plain package would delete its `workspaces` declaration in
      // generatePackageJson and skip monorepo-only conventions such as root `private: true`.
      doesContainSubPackageJsons: containsAny('packages/**/package.json', dirPath) || workspaceSubDirPaths.length > 0,
      doesContainDockerfile: !!dockerfile || fs.existsSync(path.resolve(dirPath, 'docker-compose.yml')),
      doesContainGemfile: fs.existsSync(path.resolve(dirPath, 'Gemfile')),
      doesContainGoMod: fs.existsSync(path.resolve(dirPath, 'go.mod')),
      doesContainPackageJson,
      doesContainPoetryLock: fs.existsSync(path.resolve(dirPath, 'poetry.lock')),
      doesContainUvLock: fs.existsSync(path.resolve(dirPath, 'uv.lock')),
      // Recursive like doesContainJava: multi-language repositories keep language directories
      // (e.g. Python tooling or Maven modules) outside the root and outside declared workspaces.
      doesContainPythonLockAnywhere: containsAny('**/{poetry.lock,uv.lock}', dirPath),
      doesContainPomXml: fs.existsSync(path.resolve(dirPath, 'pom.xml')),
      doesContainPomXmlAnywhere: containsAny('**/pom.xml', dirPath),
      doesContainPubspecYaml: fs.existsSync(path.resolve(dirPath, 'pubspec.yaml')),
      doesContainTauriConfig,
      doesContainTauriConfigInPackages: containsAnyInWorkspaces(
        'src-tauri/{tauri.conf.json,tauri.conf.json5,Tauri.toml}'
      ),
      doesContainTemplateYaml: fs.existsSync(path.resolve(dirPath, 'template.yaml')),
      doesContainVscodeSettingsJson: fs.existsSync(path.resolve(dirPath, '.vscode', 'settings.json')),
      doesContainJavaScript: containsAny('{app,src,test,scripts}/**/*.{cjs,mjs,js,jsx}', dirPath),
      doesContainTypeScript: containsAny('{app,src,test,scripts}/**/*.{cts,mts,ts,tsx}', dirPath),
      doesContainJsxOrTsx: containsAny('{app,src,test}/**/*.{t,j}sx', dirPath),
      doesContainJava: containsAny('**/*.java', dirPath),
      doesContainJavaScriptInPackages: containsAnyInWorkspaces('{app,src,test,scripts}/**/*.{cjs,mjs,js,jsx}'),
      doesContainTypeScriptInPackages: containsAnyInWorkspaces('{app,src,test,scripts}/**/*.{cts,mts,ts,tsx}'),
      doesContainJsxOrTsxInPackages: containsAnyInWorkspaces('{app,src,test}/**/*.{t,j}sx'),
      doesContainJavaInPackages: containsAnyInWorkspaces('**/*.java'),
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
        playwrightRuntime: runtimeImports.playwright,
        prettierRuntime: runtimeImports.prettier,
        prisma: !!dependencies['@prisma/client'] || !!devDependencies.prisma,
        pyright: !!devDependencies.pyright,
        reactNative: !!dependencies['react-native'],
        semanticRelease: usesSemanticRelease,
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
        github: releasePluginsAreExplicit
          ? releasePlugins.includes('@semantic-release/github') || releasePluginsAreUnknown
          : usesSemanticRelease,
        npm: releasePluginsAreExplicit
          ? releasePlugins.includes('@semantic-release/npm') || releasePluginsAreUnknown
          : usesSemanticRelease,
        npmPublishesRoot: releaseNpmPluginPublishesRoot,
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
 * Tells whether wbfy manages worker-configuration.d.ts for the package. The file is gitignored and untracked
 * because the `wb gen-code` postinstall regenerates it on every install, so the package has to own a wrangler
 * config (`wrangler types` exits non-zero without one), to depend on wrangler (a package deploying via a
 * CI action cannot resolve the command), and to consume the generated file.
 *
 * INVARIANT — this decision must converge across machines holding the same commit. It must NEVER consult
 * gitignored files (`.dev.vars*`, `.env*`, ...), which `wb start` and `wb deploy` create routinely and which
 * therefore stay untracked on dev machines forever: a former check that treated them as irreproducible inputs
 * made wbfy runs on dev machines re-track the ~15k-line generated file that runs from clean checkouts had
 * untracked, oscillating eternally (e.g. ai-game-builder #684 → #746). Reading committable repository files
 * from the working tree (the wrangler config, package.json, tsconfig — as every wbfy generator does) is fine:
 * any divergence there is transient and disappears once the file is committed or removed.
 * The hazard that check guarded against no longer exists: `wb gen-code` runs `wrangler types --env-file` with
 * a key stub derived solely from the committed fnox.toml (see wb's writeWorkerTypesEnvStub), so local dotenv
 * files never influence the generated `Env`.
 */
export function generatesWorkerTypes(config: PackageConfig): boolean {
  const packageJson = config.packageJson;
  return config.doesContainWranglerConfig && hasWranglerDependency(packageJson) && consumesGeneratedWorkerTypes(config);
}

export function getWorkerTypesScriptError(config: Pick<PackageConfig, 'packageJson'>): string | undefined {
  const scripts = config.packageJson?.scripts ?? {};
  let hasInvocation = false;
  for (const [name, script] of Object.entries(scripts)) {
    if (script === undefined) continue;
    const segments = splitScriptSegments(script);
    if (!wranglerTypesTextPattern.test(script)) continue;
    hasInvocation = true;
    if (!segments) return `${name} contains unsupported shell syntax around wrangler types`;
    let hasValidatedInvocation = false;
    for (const segment of segments) {
      const normalized = segment.trim().replaceAll(/\s+/gu, ' ');
      if (!wranglerTypesTextPattern.test(normalized)) continue;
      hasValidatedInvocation = true;
      const kind = classifyScriptSegment(segment, scripts, false);
      if (kind !== 'wranglerTypes') {
        return `${name} uses an unsupported wrangler types spelling`;
      }
      if (/(?:^|\s)--check(?:=true)?(?:\s|$)/u.test(normalized)) return `${name} must not check worker types directly`;
      if (!['gen-code', 'gen-types', 'postinstall'].includes(name)) {
        return `${name} must not invoke wrangler types directly`;
      }
      if (hasUnsupportedWorkerTypesArguments(normalized)) {
        return `${name} uses unsupported wrangler types arguments`;
      }
    }
    if (!hasValidatedInvocation) return `${name} uses an unsupported wrangler types spelling`;
    const generatedSegments = segments.filter(
      (segment) => classifyScriptSegment(segment, scripts, false) === 'wranglerTypes'
    );
    if (name === 'gen-types' && generatedSegments.length > 0) {
      const referencedOutsidePostinstall = Object.entries(scripts).some(
        ([otherName, otherScript]) =>
          otherName !== 'gen-types' && otherName !== 'postinstall' && mentionsPackageScript(otherScript, 'gen-types')
      );
      if (segments.length !== 1 || referencedOutsidePostinstall) {
        return 'gen-types must contain only wrangler types and must not be referenced outside postinstall';
      }
      const postinstall = scripts.postinstall;
      if (postinstall && mentionsPackageScript(postinstall, 'gen-types')) {
        const postinstallSegments = splitScriptSegments(postinstall);
        if (
          !postinstallSegments ||
          !postinstallSegments.some((segment) => classifyScriptSegment(segment, scripts, true) === 'wranglerTypes')
        ) {
          return 'postinstall must use a canonical gen-types reference';
        }
      }
    }
  }
  if (hasInvocation && !hasWranglerDependency(config.packageJson)) {
    return 'wrangler types requires a direct wrangler dependency';
  }
}

function hasWranglerDependency(packageJson: PackageJson | undefined): boolean {
  return [
    packageJson?.dependencies,
    packageJson?.devDependencies,
    packageJson?.optionalDependencies,
    packageJson?.peerDependencies,
  ].some((dependencies) => dependencies?.wrangler !== undefined);
}

const shellWordPattern = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:\\.|[^\s"'\\])+)`;
const wranglerOptionPattern = String.raw`\s+--?[A-Za-z][\w-]*(?:=${shellWordPattern}|\s+(?!-|types\b)${shellWordPattern})?`;
const wranglerTypesTextPattern = new RegExp(
  String.raw`["']?\bwrangler(?:@[^\s"']+)?\b["']?(?:${wranglerOptionPattern})*\s+types\b`,
  'u'
);

function mentionsPackageScript(script: string | undefined, scriptName: string): boolean {
  return script !== undefined && new RegExp(`\\b${escapeRegExp(scriptName)}\\b`, 'u').test(script);
}

function hasUnsupportedWorkerTypesArguments(segment: string): boolean {
  const args = segment
    .replace(/^.*?\bwrangler\s+types\b/u, '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const valueOptions = new Set(['--env-file']);
  const booleanOptions = new Set(['--include-env', '--include-runtime', '--strict-vars', '--x-include-runtime']);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    const [option, inlineValue] = argument.split('=', 2);
    if (option && valueOptions.has(option)) {
      if (inlineValue === undefined) index += 1;
    } else if (option && booleanOptions.has(option)) {
      if (inlineValue === undefined && /^(?:false|true)$/u.test(args[index + 1] ?? '')) index += 1;
    } else {
      return true;
    }
  }
  return false;
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
 * Tells whether the directory owns a Worker, unlike the isCloudflare heuristic, which also matches a package that
 * merely mentions wrangler in a script or workflow (e.g. the root of a monorepo whose Worker lives in a sub-package).
 */
function detectWranglerConfig(dirPath: string): boolean {
  return ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((fileName) =>
    fs.existsSync(path.resolve(dirPath, fileName))
  );
}

/**
 * Detects whether dirPath belongs to the willbooster-configs repository. Prefers the authoritative
 * GitHub repo name, which is immune to the local directory layout. That name is fetched only for the
 * root, so sub-packages (and offline roots) walk up to the nearest git root and match its directory
 * name: a sibling repo cloned under a parent directory named willbooster-configs stops at its own
 * `.git`, so it is not misclassified. The path segment remains a last resort when no git root exists.
 */
function detectIsWillBoosterConfigs(dirPath: string, packageJsonPath: string, repoName: string | undefined): boolean {
  if (repoName) return repoName.toLowerCase() === 'willbooster-configs';
  let current = path.resolve(dirPath);
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return path.basename(current).toLowerCase() === 'willbooster-configs';
    }
    current = path.dirname(current);
  }
  return packageJsonPath.toLowerCase().includes('/willbooster-configs/');
}

function detectCloudflare(
  packageJson: PackageJson,
  doesContainWranglerConfig: boolean,
  workflowContents: string[]
): boolean {
  const scripts = packageJson.scripts;
  if (scripts && Object.values(scripts).some((script) => typeof script === 'string' && script.includes('wrangler'))) {
    return true;
  }

  if (doesContainWranglerConfig) {
    return true;
  }

  return workflowContents.some((content) => /cloudflare|wrangler/iu.test(content));
}

function detectRailway(dirPath: string, packageJson: PackageJson, workflowContents: string[]): boolean {
  const scripts = packageJson.scripts;
  if (scripts && Object.values(scripts).some((script) => typeof script === 'string' && script.includes('railway'))) {
    return true;
  }

  if (fs.existsSync(path.resolve(dirPath, '.railwayignore')) || fs.existsSync(path.resolve(dirPath, 'railway.json'))) {
    return true;
  }

  return workflowContents.some((content) => /railway/iu.test(content));
}

/** Contents of the readable .github/workflows YAML files, read once for every detector needing them. */
function readWorkflowFileContents(dirPath: string): string[] {
  const workflowsPath = path.resolve(dirPath, '.github', 'workflows');
  try {
    return fs
      .readdirSync(workflowsPath)
      .filter((fileName) => /\.ya?ml$/iu.test(fileName))
      .flatMap((fileName) => {
        try {
          return [fs.readFileSync(path.join(workflowsPath, fileName), 'utf8')];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
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

/**
 * Whether dirPath is a child workspace of an enclosing monorepo root: either the conventional
 * `<root>/packages/<name>` layout, or a directory matching a workspace pattern declared by an
 * ancestor package.json (patterns may be arbitrarily deep, e.g. `examples/**`). The walk stops
 * at the first git repository boundary so an unrelated enclosing repository's workspaces can
 * never reclassify an independent repository as a child.
 */
function isWorkspaceOfEnclosingRoot(dirPath: string): boolean {
  const resolvedDirPath = path.resolve(dirPath);
  // A directory with its own .git is a repository in its own right, never a child workspace —
  // checked FIRST so an independent repository under some `packages/` directory stays a root.
  if (fs.existsSync(path.resolve(resolvedDirPath, '.git'))) return false;
  if (
    path.basename(path.resolve(resolvedDirPath, '..')) === 'packages' &&
    fs.existsSync(path.resolve(resolvedDirPath, '..', '..', 'package.json'))
  ) {
    return true;
  }
  for (
    let candidateRootDirPath = path.dirname(resolvedDirPath);
    ;
    candidateRootDirPath = path.dirname(candidateRootDirPath)
  ) {
    try {
      const rootPackageJson = JSON.parse(
        fs.readFileSync(path.resolve(candidateRootDirPath, 'package.json'), 'utf8')
      ) as PackageJson;
      const relativeDirPath = path.relative(candidateRootDirPath, resolvedDirPath).replaceAll('\\', '/');
      const workspaceDirPaths = getWorkspacePackageJsonPaths({
        dirPath: candidateRootDirPath,
        packageJson: rootPackageJson,
        doesContainSubPackageJsons: false,
      }).map((packageJsonPath) => path.posix.dirname(packageJsonPath));
      if (workspaceDirPaths.includes(relativeDirPath)) return true;
    } catch {
      // No or unparsable manifest at this ancestor: keep walking.
    }
    const isRepoBoundary = fs.existsSync(path.resolve(candidateRootDirPath, '.git'));
    const isFilesystemRoot = candidateRootDirPath === path.dirname(candidateRootDirPath);
    if (isRepoBoundary || isFilesystemRoot) return false;
  }
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

// `prettier` is normally stripped in favor of oxfmt, but a package that imports it as a library
// (e.g. formatting HTML at runtime) must keep it declared, or isolated installs turn it into a
// phantom dependency. Subpath specifiers like `prettier/standalone` count too. Both packages are
// detected in one pass so every source file is globbed and read only once.
function detectRuntimeImports(dirPath: string): { playwright: boolean; prettier: boolean } {
  const files = fg.globSync('{app,src}/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}', {
    dot: true,
    cwd: dirPath,
    ignore: [...globIgnore, '**/__tests__/**', '**/*.spec.*', '**/*.test.*', '**/playwright.config.*'],
  });
  const result = { playwright: false, prettier: false };
  const regExps = {
    playwright: buildRuntimeImportRegExp('playwright'),
    prettier: buildRuntimeImportRegExp('prettier'),
  };
  for (const file of files) {
    const content = fs.readFileSync(path.resolve(dirPath, file), 'utf8');
    result.playwright ||= regExps.playwright.test(content);
    result.prettier ||= regExps.prettier.test(content);
    if (result.playwright && result.prettier) break;
  }
  return result;
}

function buildRuntimeImportRegExp(packageName: string): RegExp {
  // Match the bare specifier or any subpath of it (`pkg` / `pkg/sub`), but never a different package
  // that merely shares the prefix (`pkg-other`), since the char after the name must be `/` or a quote.
  const specifier = String.raw`['"]${escapeRegExp(packageName)}(?:/[^'"]*)?['"]`;
  return new RegExp(
    String.raw`\bfrom\s+${specifier}|\bimport\s*\(\s*${specifier}\s*\)|\brequire\s*\(\s*${specifier}\s*\)`,
    'u'
  );
}

async function fetchRepoInfo(dirPath: string, packageJson: PackageJson): Promise<Record<string, unknown> | undefined> {
  let remoteUrl: string | undefined;
  try {
    const remotes = await simpleGit(dirPath).getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    remoteUrl = origin?.refs.fetch ?? origin?.refs.push;
  } catch {
    // Not a git repository (e.g. a scratch directory); fall back to package.json's repository.
  }
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
    // Metadata permission. The owner MUST be passed: getOctokit() without it prefers the
    // WillBooster PAT, which cannot read private WillBoosterLab repositories, collapsing their
    // visibility to unknown (and e.g. skipping the wbfy caller generation indefinitely).
    const response = await getOctokit(org).request('GET /repos/{owner}/{repo}', {
      owner: org,
      repo: name,
    });
    return response.data;
  } catch (error) {
    const redirectedFullName = getRedirectedRepoFullName(error);
    if (redirectedFullName) {
      // Re-fetch under the redirected identity so a renamed repository still gets complete
      // metadata (visibility included) instead of a bare full_name that would leave
      // isRepoVisibilityKnown false on every subsequent run with the stale remote URL.
      const [redirectedOrg, redirectedName] = redirectedFullName.split('/');
      if (redirectedOrg && redirectedName) {
        try {
          const response = await getOctokit(redirectedOrg).request('GET /repos/{owner}/{repo}', {
            owner: redirectedOrg,
            repo: redirectedName,
          });
          return response.data;
        } catch {
          // Fall back to the bare identity below: the repository is still canonicalized, only
          // its visibility stays unknown.
        }
      }
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

/**
 * Resolves `<org>/<name>` from the git remote (falling back to package.json's `repository`) without
 * calling the GitHub API. It works for every workspace package, not just the root — only the root
 * fetches repo info — and it keeps working offline or rate-limited, where an undefined identity
 * would silently reclassify the repository (e.g. making wbfy write willbooster-configs' Renovate
 * preset into the preset itself again).
 */
async function resolveLocalRepoIdentity(
  dirPath: string,
  packageJson: PackageJson
): Promise<[string | undefined, string | undefined]> {
  try {
    const remotes = await simpleGit(dirPath).getRemotes(true);
    const origin = remotes.find((remote) => remote.name === 'origin');
    const remoteUrl = origin?.refs.fetch ?? origin?.refs.push;
    if (remoteUrl) {
      const identity = readGitHubIdentity(remoteUrl);
      if (identity) return identity;
    }
  } catch {
    // Not a git repository, or git is unavailable: fall through to the manifest.
  }
  const url = typeof packageJson.repository === 'string' ? packageJson.repository : packageJson.repository?.url;
  if (url) {
    const identity = readGitHubIdentity(url);
    if (identity) return identity;
  }
  return [undefined, undefined];
}

/**
 * `gitHubUtil.getOrgAndName` is host-agnostic, so it happily turns a GitLab URL into an `<org>/<repo>` pair.
 * Everything downstream treats the resulting identity as GitHub (the `github:` repository field is rewritten
 * into package.json), so the host must be verified first; a non-GitHub remote yields no identity, as before.
 */
function readGitHubIdentity(url: string): [string, string] | undefined {
  if (!targetsGitHub(url)) return undefined;
  const [org, name] = gitHubUtil.getOrgAndName(url);
  return org && name ? [canonicalizeOwner(org), name] : undefined;
}

/**
 * Whether the URL's HOST is github.com. Parsed rather than substring-matched: a path such as
 * `https://gitlab.com/github.com/owner/repo.git` would otherwise be taken for GitHub, and an uppercase
 * `GITHUB.COM` would be rejected. `github:owner/repo` is npm's shorthand and names no host, so it is
 * recognized separately; normalizeRepositoryUrlForPackageJson accepts the same shorthand.
 */
function targetsGitHub(url: string): boolean {
  if (/^github:/iu.test(url)) return true;
  // scp-style remotes (`git@github.com:owner/repo.git`) are not valid URLs.
  const scpHost = /^[^/@]*@([^:/]+):/u.exec(url)?.[1];
  if (scpHost) return scpHost.toLowerCase() === 'github.com';
  try {
    return new URL(url.replace(/^git\+/u, '')).hostname.toLowerCase() === 'github.com';
  } catch {
    return false;
  }
}

/**
 * GitHub owner names are case-insensitive, and a remote or manifest URL may spell them any way, but the API's
 * `full_name` always returned the canonical spelling — which the many exact `=== 'WillBooster'` policy checks
 * (organization workflows, author metadata, the WillBoosterLab pre-push guard) depend on. Canonicalize here so
 * the local fallback yields the same identity the API did, instead of silently skipping those policies.
 */
function canonicalizeOwner(owner: string): string {
  const canonicalOwners = ['WillBooster', 'WillBoosterLab'];
  return canonicalOwners.find((candidate) => candidate.toLowerCase() === owner.toLowerCase()) ?? owner;
}
