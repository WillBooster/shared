import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import fg from 'fast-glob';
import semver from 'semver';
import { sortPackageJson } from 'sort-package-json';
import * as ast from 'typescript/unstable/ast';
import type { PackageJson, SetRequired } from 'type-fest';

import { getLatestCommitHash } from '../github/commit.js';
import { logger } from '../logger.js';
import { generatesWorkerTypes, type PackageConfig } from '../packageConfig.js';
import { extensions } from '../utils/extensions.js';
import { fsUtil } from '../utils/fsUtil.js';
import { gitHubUtil } from '../utils/githubUtil.js';
import { globIgnore } from '../utils/globUtil.js';
import { ignoreFileUtil } from '../utils/ignoreFileUtil.js';
import { combineMerge } from '../utils/mergeUtil.js';
import { doesContainJava, doesContainJsOrTs } from '../utils/packageCapabilities.js';
import { promisePool } from '../utils/promisePool.js';
import { spawnSync, spawnSyncAndReturnStdout } from '../utils/spawnUtil.js';
import { getTsconfigBaseDependencies, managedTsconfigBaseDependencies } from '../utils/tsconfigBase.js';
import { parseSourceFile } from '../utils/typescriptApi.js';
import { isPublishedWillboosterConfigsPackage } from '../utils/willboosterConfigsUtil.js';
import { bunMinimumReleaseAgeExcludes, bunMinimumReleaseAgeSeconds } from './bunfig.js';
import { yarnNpmMinimalAgeGate, yarnNpmPreapprovedPackages } from './yarnrc.js';

const oxlintDeps = ['@willbooster/oxfmt-config', '@willbooster/oxlint-config', 'oxfmt', 'oxlint', 'oxlint-tsgolint'];
const typescriptDependency = 'typescript';
// TypeScript 7's `typescript` package is the tsgo native compiler and exposes no
// programmatic API. Next.js's build-time `verifyTypeScriptSetup` needs that API, so
// `next build` fails ("trying to use TypeScript but do not have the required package(s)")
// with only `typescript` v7 installed. Next.js resolves the tsgo binary through the
// separate `@typescript/native-preview` package, so Next.js-family repos must install
// both; other repos only need `typescript` for `tsc` typechecks.
const typescriptGoDependency = '@typescript/native-preview';
const wbDependency = '@willbooster/wb';
const buildTsDependency = 'build-ts';
const lefthookDependency = 'lefthook';
const defaultGenI18nTsScript = 'gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP';
const managedDependencyNames = new Set([
  wbDependency,
  buildTsDependency,
  lefthookDependency,
  typescriptDependency,
  typescriptGoDependency,
  'sort-package-json',
  ...oxlintDeps,
]);
const willBoosterConfigsManagedDependencies = [
  '@willbooster/prettier-config',
  ...oxlintDeps.filter((dependency) => dependency.startsWith('@willbooster/')),
];
const obsoleteLintDependencies = [
  '@biomejs/biome',
  '@eslint-react/eslint-plugin',
  '@eslint/js',
  '@next/eslint-plugin-next',
  '@types/eslint',
  '@types/micromatch',
  '@typescript-eslint/eslint-plugin',
  '@typescript-eslint/parser',
  '@willbooster/biome-config',
  '@willbooster/eslint-config',
  '@willbooster/eslint-config-blitz-next',
  '@willbooster/eslint-config-js',
  '@willbooster/eslint-config-js-react',
  '@willbooster/eslint-config-next',
  '@willbooster/eslint-config-react',
  '@willbooster/eslint-config-ts',
  '@willbooster/eslint-config-ts-react',
  'biome',
  'eslint',
  'eslint-config-flat-gitignore',
  'eslint-config-next',
  'eslint-config-prettier',
  'eslint-import-resolver-node',
  'eslint-import-resolver-typescript',
  'eslint-plugin-import',
  'eslint-plugin-import-x',
  'eslint-plugin-perfectionist',
  'eslint-plugin-prettier',
  'eslint-plugin-react',
  'eslint-plugin-react-compiler',
  'eslint-plugin-react-hooks',
  'eslint-plugin-sort-class-members',
  'eslint-plugin-sort-destructure-keys',
  'eslint-plugin-storybook',
  'eslint-plugin-unicorn',
  'eslint-plugin-unused-imports',
  'globals',
  'micromatch',
  'typescript-eslint',
];
const micromatchPackageNames = new Set(['micromatch', '@types/micromatch']);
const micromatchImportPattern =
  /\bfrom\s+['"]micromatch['"]|\brequire\(\s*['"]micromatch['"]\s*\)|\bimport\(\s*['"]micromatch['"]\s*\)/u;

const latestDependencyVersionCache = new Map<string, string>();
const npmPackageTimesCache = new Map<string, Record<string, string>>();
const dependencySectionKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

type WritablePackageJson = SetRequired<
  PackageJson,
  'scripts' | 'dependencies' | 'devDependencies' | 'peerDependencies'
>;

interface DependencyUpdates {
  dependencies: string[];
  devDependencies: string[];
  pythonDevDependencies: string[];
}

export async function generatePackageJson(
  config: PackageConfig,
  rootConfig: PackageConfig,
  skipAddingDeps: boolean
): Promise<void> {
  return logger.functionIgnoringException('generatePackageJson', async () => {
    await core(config, rootConfig, skipAddingDeps);
  });
}

async function core(config: PackageConfig, rootConfig: PackageConfig, skipAddingDeps: boolean): Promise<void> {
  const filePath = path.resolve(config.dirPath, 'package.json');
  const jsonObj = await readPackageJson(filePath);
  const packageManager = config.isBun ? 'bun' : 'yarn';

  await removeDeprecatedStuff(config, jsonObj);
  await updateScripts(config, jsonObj);
  moveManagedToolDependenciesToDevDependencies(jsonObj);
  const dependencyUpdates = await applyPackageJsonConventions(config, rootConfig, jsonObj);
  await normalizePackageMetadata(config, rootConfig, jsonObj, dependencyUpdates);
  addDependencyVersionsToPackageJson(config, jsonObj, dependencyUpdates, skipAddingDeps);
  await updatePrivatePackages(jsonObj);
  removeEmptyDependencySections(jsonObj);

  if (config.isBun) delete jsonObj.packageManager;
  // Yarn reads package.json from disk before deciding whether `yarn add -D`
  // conflicts with an existing regular dependency, so this write must finish
  // before installing the managed dependency updates below. Keep this generated
  // file sorted even when we later run the target repository's formatter so a
  // mid-run interruption never leaves package.json in a partially managed order.
  await fsUtil.generateFile(filePath, serializePackageJson(jsonObj));

  if (!skipAddingDeps) {
    installDependencyUpdates(config, jsonObj, dependencyUpdates, packageManager);
    formatPackageJsonWithProjectFormatter(config, packageManager, filePath);
  }
}

function serializePackageJson(jsonObj: WritablePackageJson): string {
  // fsUtil.generateFile() normalizes the trailing newline, so keep the serializer
  // focused on the JSON payload itself.
  return JSON.stringify(sortPackageJson(jsonObj), undefined, 2);
}

async function readPackageJson(filePath: string): Promise<WritablePackageJson> {
  const jsonText = await fs.promises.readFile(filePath, 'utf8');
  const jsonObj = JSON.parse(jsonText) as PackageJson;
  jsonObj.scripts = jsonObj.scripts ?? {};
  jsonObj.dependencies = jsonObj.dependencies ?? {};
  jsonObj.devDependencies = jsonObj.devDependencies ?? {};
  jsonObj.peerDependencies = jsonObj.peerDependencies ?? {};
  return jsonObj as WritablePackageJson;
}

async function updateScripts(config: PackageConfig, jsonObj: WritablePackageJson): Promise<void> {
  removeLegacyInstallCommands(jsonObj.scripts);

  jsonObj.scripts = { ...jsonObj.scripts, ...generateScripts(config, jsonObj.scripts) };
  delete jsonObj.scripts['start-test-server'];

  const scripts = jsonObj.scripts;
  if (config.isBun || !doesContainJava(config)) {
    delete scripts.prettify;
  } else {
    scripts.prettify = (scripts.prettify ?? '') + (await generatePrettierSuffix(config.dirPath));
  }
  normalizeYarnWorkspaceForeachScripts(scripts);
  normalizeRailwayCliScript(config, scripts);
}

function removeLegacyInstallCommands(scripts: PackageJson.Scripts): void {
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value !== 'string') continue;
    // Fresh repos still require standalone `yarn install`; only remove legacy install prefixes before another command.
    if (!value.includes('git clone')) {
      scripts[key] = value.replaceAll(/yarn\s*(?:install\s*)?&&\s*/gu, '');
    }
  }
}

function updatePostinstallScript(scripts: PackageJson.Scripts, wranglerTypes: string | undefined): void {
  if (scripts['gen-code']) {
    scripts.postinstall = appendWranglerTypes('wb gen-code', wranglerTypes);
  } else if (scripts.postinstall?.includes('gen-i18n-ts')) {
    delete scripts.postinstall;
  }
  // A Worker package without a gen-code script still needs worker-configuration.d.ts before type checking.
  if (!wranglerTypes || scripts.postinstall?.includes('wrangler types')) return;

  scripts.postinstall = appendWranglerTypes(scripts.postinstall ?? '', wranglerTypes).replace(/^ && /u, '');
}

/**
 * Resolves the single `wrangler types` command that every managed script must run, or undefined when wbfy does not
 * manage worker-configuration.d.ts for the package.
 *
 * Scanning every script (not just postinstall) matters because projects keep the flagged invocation in a script of
 * their own, e.g. `"gen-types": "wrangler types --strict-vars=false"`. Reusing it keeps the declarations wbfy
 * regenerates identical to the ones the project intended: --strict-vars=false widens `vars` to string, whereas the
 * default emits literal union types. Both managed scripts get the same command so the file cannot depend on which of
 * them ran last.
 */
function resolveWranglerTypesCommand(config: PackageConfig, scripts: PackageJson.Scripts): string | undefined {
  if (!generatesWorkerTypes(config)) return;

  const customCommand = Object.values(scripts)
    .filter((script) => typeof script === 'string')
    .flatMap((script) => script.split('&&').map((segment) => segment.trim()))
    // Only an invocation passing flags is worth preserving; a bare one is normalized to the managed command.
    .find((segment) => /(?:^|\s)wrangler types\s+\S/u.test(segment));
  return customCommand ?? `${config.isBun ? 'bunx ' : ''}wrangler types`;
}

/**
 * Cloudflare Workers projects rely on `wrangler types` to (re)generate the gitignored worker-configuration.d.ts.
 * Because `wb gen-code` does not produce it, append the command to code-generation scripts; otherwise a fresh
 * checkout (e.g. CI) would fail type checking.
 */
function appendWranglerTypes(script: string, wranglerTypes: string | undefined): string {
  if (!wranglerTypes) return script;
  return `${script} && ${wranglerTypes}`;
}

function normalizeYarnWorkspaceForeachScripts(scripts: PackageJson.Scripts): void {
  // Deal with breaking changes in yarn berry 4.0.0-rc.49
  for (const [key, value] of Object.entries(scripts)) {
    if (!value?.includes('yarn workspaces foreach')) continue;
    scripts[key] = value.replaceAll(
      /yarn workspaces foreach(?!\s+(?:-A|-R|--(?:all|recursive|since|worktree|from|include|exclude|public|private)))/gu,
      'yarn workspaces foreach --all'
    );
  }
}

function normalizeRailwayCliScript(config: PackageConfig, scripts: PackageJson.Scripts): void {
  if (config.isBun || !scripts.railway?.includes('@railway/cli')) return;

  scripts.railway = 'YARN_ENABLE_SCRIPTS=true yarn dlx @railway/cli';
}

async function applyPackageJsonConventions(
  config: PackageConfig,
  rootConfig: PackageConfig,
  jsonObj: WritablePackageJson
): Promise<DependencyUpdates> {
  const dependencies: string[] = [];
  const devDependencies = ['sort-package-json'];
  const pythonDevDependencies: string[] = [];
  const hasJava = doesContainJava(config);

  if (
    hasJava &&
    !fs.existsSync(path.join(rootConfig.dirPath, '.prettierrc.json')) &&
    !fs.existsSync(path.join(config.dirPath, '.prettierrc.json'))
  ) {
    jsonObj.prettier = '@willbooster/prettier-config';
    devDependencies.push('prettier-plugin-java', '@willbooster/prettier-config');
  }
  if (hasJava) {
    devDependencies.push('prettier');
  } else {
    removePrettierArtifacts(jsonObj);
  }

  delete jsonObj.devDependencies['lint-staged'];
  delete (jsonObj as PackageJson & { 'lint-staged'?: unknown })['lint-staged'];

  if (config.isRoot) {
    delete jsonObj.devDependencies.husky;
    delete jsonObj.scripts.postpublish;
    delete jsonObj.scripts.prepublishOnly;
    delete jsonObj.scripts.prepack;
    delete jsonObj.scripts.postpack;
    jsonObj.scripts.prepare = 'lefthook install || true';
    devDependencies.push(lefthookDependency);

    if (config.depending.semanticRelease) {
      if (doesReleaseScriptInstallSemanticRelease(jsonObj.scripts.release)) {
        delete jsonObj.devDependencies['semantic-release'];
      } else if (
        !jsonObj.devDependencies['semantic-release'] &&
        !jsonObj.devDependencies['multi-semantic-release'] &&
        !jsonObj.devDependencies['@qiwi/multi-semantic-release']
      ) {
        devDependencies.push('semantic-release');
      }
      jsonObj.version = '0.0.0-semantically-released';
    }

    if (config.depending.playwrightTest) {
      // Since artillery requires a specific version of @playwright/test
      const hasArtillery = jsonObj.dependencies.artillery || jsonObj.devDependencies.artillery;
      // Since llm-toolbox requires @playwright/test in dependencies
      if (!hasArtillery && !jsonObj.dependencies['@playwright/test']) {
        devDependencies.push('@playwright/test');
      }
      if (config.depending.playwrightRuntime) {
        // Runtime imports need the standalone package after Docker pruning removes devDependencies.
        jsonObj.dependencies.playwright ??=
          jsonObj.devDependencies.playwright ??
          jsonObj.dependencies['@playwright/test'] ??
          jsonObj.devDependencies['@playwright/test'];
        dependencies.push('playwright');
        delete jsonObj.devDependencies.playwright;
      } else {
        delete jsonObj.dependencies.playwright;
        delete jsonObj.devDependencies.playwright;
      }
    }

    if (config.doesContainSubPackageJsons) {
      // We don't allow non-array workspaces in monorepo.
      jsonObj.workspaces = Array.isArray(jsonObj.workspaces)
        ? merge.all([jsonObj.workspaces, ['packages/*']], {
            arrayMerge: combineMerge,
          })
        : ['packages/*'];
    } else if (Array.isArray(jsonObj.workspaces)) {
      jsonObj.workspaces = jsonObj.workspaces.filter(
        (workspace) =>
          fg.globSync(workspace, {
            dot: true,
            cwd: config.dirPath,
            ignore: globIgnore,
          }).length > 0
      );
      if (jsonObj.workspaces.length === 0) {
        delete jsonObj.workspaces;
      }
    }
  }

  // fixers/nextConfig.ts enables `reactCompiler: true` for every Next.js project, and Next.js
  // resolves `babel-plugin-react-compiler` at build time when React Compiler is on. Add it here so
  // the managed next.config never breaks `next build` with an unresolved-package error.
  if (config.depending.next) {
    devDependencies.push('babel-plugin-react-compiler');
  }

  if (!isWbPackage(jsonObj)) {
    if (shouldKeepWbAsRuntimeDependency(jsonObj)) {
      dependencies.push(wbDependency);
    } else {
      devDependencies.push(wbDependency);
    }
  }
  // build-ts owns TypeScript execution and declaration emit. wbfy must always
  // keep existing build-ts users current because older releases can emit .d.ts
  // files at paths that no longer match package exports.
  if (
    jsonObj.dependencies[buildTsDependency] ||
    jsonObj.devDependencies[buildTsDependency] ||
    Object.values(jsonObj.scripts).some((script) => script?.includes(buildTsDependency))
  ) {
    if (shouldKeepBuildTsAsRuntimeDependency(jsonObj)) {
      dependencies.push(buildTsDependency);
    } else {
      devDependencies.push(buildTsDependency);
    }
  }
  if (doesContainJsOrTs(config)) {
    devDependencies.push(...oxlintDeps);
  }

  const tsconfigBaseDependencies = doesContainJsOrTs(config) ? getTsconfigBaseDependencies(config) : [];
  await removeUnusedTsconfigBaseDependencies(config, jsonObj, tsconfigBaseDependencies);
  devDependencies.push(...tsconfigBaseDependencies);

  if (config.doesContainTypeScript || config.doesContainTypeScriptInPackages) {
    // TypeScript 7 ships the native compiler as the `typescript` package, so it is
    // now the managed compiler for every TypeScript repo (typechecking runs `tsc`).
    devDependencies.push(typescriptDependency);
    // Next.js's `next build` inspects `@typescript/native-preview` (tsgo) to run its type
    // check; the `typescript` v7 package alone lacks the API next needs, so keep both
    // installed for Next.js-family repos. See the typescriptGoDependency comment above.
    if (config.depending.next || config.depending.blitz || config.depending.vinext) {
      devDependencies.push(typescriptGoDependency);
    }
    if (config.isBun) {
      devDependencies.push('@types/bun');
    } else if (!config.depending.reactNative) {
      devDependencies.push('@types/node');
    }
    if (
      jsonObj.dependencies.jest ||
      jsonObj.devDependencies.jest ||
      jsonObj.dependencies['@jest/globals'] ||
      jsonObj.devDependencies['@jest/globals'] ||
      jsonObj.dependencies['ts-jest'] ||
      jsonObj.devDependencies['ts-jest']
    ) {
      devDependencies.push('@types/jest');
    }
  }

  if (config.isWillBoosterConfigs) {
    return {
      dependencies: dependencies.filter((dep) => !dep.includes('@willbooster/')),
      devDependencies: devDependencies.filter((dep) => !dep.includes('@willbooster/')),
      pythonDevDependencies,
    };
  }

  return { dependencies, devDependencies, pythonDevDependencies };
}

function doesReleaseScriptInstallSemanticRelease(script: unknown): boolean {
  if (typeof script !== 'string') return false;
  return /\b(?:bunx|npx|pnpm\s+dlx|yarn\s+dlx)\s+semantic-release(?:@\S+)?\b/u.test(script);
}

function moveManagedToolDependenciesToDevDependencies(jsonObj: WritablePackageJson): void {
  for (const [dependency, keepAsRuntime] of [
    [wbDependency, shouldKeepWbAsRuntimeDependency(jsonObj)],
    [buildTsDependency, shouldKeepBuildTsAsRuntimeDependency(jsonObj)],
  ] as const) {
    if (keepAsRuntime) {
      const devVersion = jsonObj.devDependencies[dependency];
      if (!devVersion) continue;
      const runtimeVersion = jsonObj.dependencies[dependency];
      if (!runtimeVersion || isNewerPackageVersion(devVersion, runtimeVersion)) {
        jsonObj.dependencies[dependency] = devVersion;
      }
      delete jsonObj.devDependencies[dependency];
    } else if (jsonObj.dependencies[dependency]) {
      jsonObj.devDependencies[dependency] ??= jsonObj.dependencies[dependency];
      delete jsonObj.dependencies[dependency];
    }
  }
}

function shouldKeepWbAsRuntimeDependency(jsonObj: PackageJson): boolean {
  const postinstallScript = jsonObj.scripts?.postinstall;
  return typeof postinstallScript === 'string' && /\bwb\b/u.test(postinstallScript);
}

function shouldKeepBuildTsAsRuntimeDependency(jsonObj: PackageJson): boolean {
  const prisma = jsonObj.prisma as { seed?: unknown } | undefined;
  return doesSeedCommandUseBuildTs(prisma?.seed) || doesSeedCommandUseBuildTs(jsonObj.scripts?.seed);
}

function doesSeedCommandUseBuildTs(seedCommand: unknown): boolean {
  // Production Docker images run seed scripts after devDependencies are pruned,
  // so TypeScript seed runners must remain available at runtime.
  return typeof seedCommand === 'string' && /(?<![\w-])build-ts(?![\w-])/u.test(seedCommand);
}

async function normalizePackageMetadata(
  config: PackageConfig,
  rootConfig: PackageConfig,
  jsonObj: WritablePackageJson,
  dependencyUpdates: DependencyUpdates
): Promise<void> {
  if (!jsonObj.name) {
    jsonObj.name = path.basename(config.dirPath);
  }

  if (config.doesContainSubPackageJsons) {
    jsonObj.private = true;
  }
  if (!jsonObj.license) {
    jsonObj.license = 'UNLICENSED';
  }
  if (!jsonObj.private && jsonObj.license !== 'UNLICENSED' && rootConfig.isPublicRepo) {
    jsonObj.publishConfig ??= {};
    jsonObj.publishConfig.access ??= 'public';
  }
  const [owner] = gitHubUtil.getOrgAndName(config.repository ?? '');
  if (owner === 'WillBooster' || owner === 'WillBoosterLab') {
    jsonObj.author = 'WillBooster Inc.';
  }
  await normalizePublishedConfigPackageMetadata(config, jsonObj);
  if (!config.isRoot && jsonObj.private && !jsonObj.main) {
    // Make VSCode possible to refactor code across subpackages.
    jsonObj.main = './src';
  }

  // Yarn treats the legacy npm/chalk resolution alias as an invalid package token.
  delete jsonObj.resolutions?.['npm/chalk'];

  if (!config.doesContainSubPackageJsons) {
    if (!config.isBun) {
      if (!config.doesContainJavaScript && !config.doesContainTypeScript) {
        delete jsonObj.scripts.lint;
        delete jsonObj.scripts['lint-fix'];
        for (const scriptName of ['cleanup']) {
          const script = jsonObj.scripts[scriptName];
          if (!script) continue;
          jsonObj.scripts[scriptName] = script.replace(/ ?&& ?yarn lint-fix(?: --quiet)?/, '');
        }
      } else {
        jsonObj.scripts['lint-fix'] = jsonObj.scripts['lint-fix'] ?? 'yarn lint --fix';
      }
    }

    if (config.doesContainPubspecYaml) {
      jsonObj.scripts.lint = 'flutter analyze';
      jsonObj.scripts['lint-fix'] = 'yarn lint';
      const dirs = ['lib', 'test', 'test_driver'].filter((dir) => fs.existsSync(path.resolve(config.dirPath, dir)));
      if (dirs.length > 0) {
        jsonObj.scripts['format-code'] = `dart format $(find ${dirs.join(
          ' '
        )} -name generated -prune -o -name '*.freezed.dart' -prune -o -name '*.g.dart' -prune -o -name '*.dart' -print)`;
        jsonObj.scripts.format = appendFormatCodeCommand(jsonObj.scripts.format, config);
      }
    }

    const pythonPackageManager = getPythonPackageManager(config);
    if (pythonPackageManager) {
      if (jsonObj.scripts.postinstall === 'poetry install') {
        delete jsonObj.scripts.postinstall;
      }
      const scriptRunner = config.isBun ? 'bun run' : 'yarn';
      jsonObj.scripts['common/ci-setup'] = `${scriptRunner} setup-${pythonPackageManager}`;
      delete jsonObj.scripts[`setup-${pythonPackageManager === 'poetry' ? 'uv' : 'poetry'}`];
      delete jsonObj.scripts['setup-poetry-asdf'];
      jsonObj.scripts[`setup-${pythonPackageManager}`] = getPythonSetupCommand(pythonPackageManager);
      const pythonFiles = await fg.glob('**/*.py', {
        cwd: config.dirPath,
        dot: true,
        ignore: globIgnore,
      });
      const dirNameSet = new Set<string>();
      for (const pythonFile of pythonFiles) {
        const [first, second] = pythonFile.split('/');
        if (first && second) {
          dirNameSet.add(first);
        }
      }
      if (dirNameSet.size > 0) {
        const dirNamesStr = [...dirNameSet].join(' ');
        const pythonRunner = `${pythonPackageManager} run`;
        jsonObj.scripts['format-code'] =
          `${pythonRunner} isort --profile black ${dirNamesStr} && ${pythonRunner} black ${dirNamesStr}`;
        if (jsonObj.scripts.lint) {
          jsonObj.scripts.lint = `${pythonRunner} flake8 ${dirNamesStr} && ${jsonObj.scripts.lint}`;
        } else {
          jsonObj.scripts.lint = `${pythonRunner} flake8 ${dirNamesStr}`;
          jsonObj.scripts['lint-fix'] = `${scriptRunner} lint`;
        }
        jsonObj.scripts.format = appendFormatCodeCommand(jsonObj.scripts.format, config);
        dependencyUpdates.pythonDevDependencies.push('black', 'isort', 'flake8');
      }
    }
  }

  if (config.repository || jsonObj.repository) {
    jsonObj.repository = formatRepositoryForPackageJson(config.repository ?? jsonObj.repository, jsonObj.repository);
  }

  // Resolved before the managed scripts are overwritten, so a project-specific invocation is still visible.
  const wranglerTypes = resolveWranglerTypesCommand(config, jsonObj.scripts);
  const genCodeScript = jsonObj.scripts['gen-code'];
  if (genCodeScript?.includes('No code generation needed')) {
    delete jsonObj.scripts['gen-code'];
  } else if (shouldGenerateWbGenCodeScript(config, genCodeScript)) {
    jsonObj.scripts['gen-code'] = appendWranglerTypes(`${config.isBun ? 'bun ' : ''}wb gen-code`, wranglerTypes);
  }
  normalizeGenI18nTsScript(config, jsonObj);
  updatePostinstallScript(jsonObj.scripts, wranglerTypes);

  if (!jsonObj.dependencies.prettier) {
    // Because @types/prettier blocks prettier execution.
    delete jsonObj.devDependencies['@types/prettier'];
  }
}

function shouldGenerateWbGenCodeScript(config: PackageConfig, oldGenCodeScript: string | undefined): boolean {
  return (
    config.depending.blitz ||
    config.depending.chakra ||
    config.depending.genI18nTs ||
    config.depending.prisma ||
    (config.depending.drizzle && !!oldGenCodeScript?.includes('drizzle-kit check'))
  );
}

function appendFormatCodeCommand(formatScript: string | undefined, config: PackageConfig): string {
  // Bun projects may not have a Yarn lockfile, so generated package scripts
  // must invoke local package scripts through the repository's package manager.
  const scriptRunner = config.isBun ? 'bun run' : 'yarn';
  return formatScript ? `${formatScript} && ${scriptRunner} format-code` : `${scriptRunner} format-code`;
}

function normalizeGenI18nTsScript(config: PackageConfig, jsonObj: WritablePackageJson): void {
  if (!shouldManageGenI18nTs(config)) return;

  if (jsonObj.scripts['gen-i18n-ts'] === defaultGenI18nTsScript) {
    delete jsonObj.scripts['gen-i18n-ts'];
  }
}

async function normalizePublishedConfigPackageMetadata(
  config: PackageConfig,
  jsonObj: WritablePackageJson
): Promise<void> {
  if (!isPublishedWillboosterConfigsPackage(config)) return;

  const configMjsPath = path.resolve(config.dirPath, 'config.mjs');
  if (!fs.existsSync(configMjsPath)) return;

  jsonObj.type = 'module';

  const configDtsPath = path.resolve(config.dirPath, 'config.d.ts');
  if (!fs.existsSync(configDtsPath)) return;

  jsonObj.files = [...new Set([...(jsonObj.files ?? []), 'config.d.mts'])];
  // NodeNext resolves a relative `./config.mjs` import to `config.d.mts`, not
  // the package-level `types` field. Keep the published config importable from
  // package-local TypeScript linter settings.
  await promisePool.run(() => fsUtil.generateFile(path.resolve(config.dirPath, 'config.d.mts'), configDmtsContent));
}

const configDmtsContent = `export { default } from './config.js';
`;

function addDependencyVersionsToPackageJson(
  config: PackageConfig,
  jsonObj: WritablePackageJson,
  dependencyUpdates: DependencyUpdates,
  skipAddingDeps: boolean
): void {
  const packageJsonDependencies = jsonObj.dependencies;
  const packageJsonDevDependencies = jsonObj.devDependencies;
  dependencyUpdates.dependencies = addPackageJsonDependencies(
    config,
    jsonObj,
    packageJsonDependencies,
    [...dependencyUpdates.dependencies, ...getExistingManagedDependencies(packageJsonDependencies)],
    skipAddingDeps
  );
  dependencyUpdates.devDependencies = dependencyUpdates.devDependencies.filter((dep) => !packageJsonDependencies[dep]);
  dependencyUpdates.devDependencies = addPackageJsonDependencies(
    config,
    jsonObj,
    packageJsonDevDependencies,
    [...dependencyUpdates.devDependencies, ...getExistingManagedDependencies(packageJsonDevDependencies)],
    skipAddingDeps
  );
}

function getExistingManagedDependencies(packageJsonDependencies: Partial<Record<string, string>>): string[] {
  return Object.keys(packageJsonDependencies).filter((dependency) => managedDependencyNames.has(dependency));
}

function removeEmptyDependencySections(jsonObj: PackageJson): void {
  for (const key of dependencySectionKeys) {
    const section = jsonObj[key];
    if (section && Object.keys(section).length === 0) {
      Reflect.deleteProperty(jsonObj, key);
    }
  }
}

function installDependencyUpdates(
  config: PackageConfig,
  jsonObj: PackageJson,
  dependencyUpdates: DependencyUpdates,
  packageManager: 'bun' | 'yarn'
): void {
  const dependencies = dependencyUpdates.dependencies.filter((dep) => !jsonObj.devDependencies?.[dep]);
  installNpmDependencies(config, packageManager, dependencies, false);

  const devDependencies = dependencyUpdates.devDependencies.filter((dep) => !jsonObj.dependencies?.[dep]);
  installNpmDependencies(config, packageManager, devDependencies, true);

  const pythonPackageManager = getPythonPackageManager(config);
  if (pythonPackageManager && dependencyUpdates.pythonDevDependencies.length > 0) {
    const dependencies = [...new Set(dependencyUpdates.pythonDevDependencies)];
    if (pythonPackageManager === 'poetry') {
      spawnSync('poetry', ['add', '--group', 'dev', ...dependencies], config.dirPath);
    } else {
      spawnSync('uv', ['add', '--dev', ...dependencies], config.dirPath);
    }
  }
}

function getPythonPackageManager(config: PackageConfig): 'poetry' | 'uv' | undefined {
  if (config.doesContainUvLock) return 'uv';
  if (config.doesContainPoetryLock) return 'poetry';
}

function getPythonSetupCommand(packageManager: 'poetry' | 'uv'): string {
  if (packageManager === 'uv') return 'uv sync --frozen';
  return 'poetry config virtualenvs.in-project true && poetry env use $(mise current python) && poetry run pip install --upgrade pip && poetry install';
}

function installNpmDependencies(
  config: PackageConfig,
  packageManager: 'bun' | 'yarn',
  dependencies: string[],
  dev: boolean
): void {
  if (dependencies.length === 0) return;

  const dependencySpecifiers = [
    ...new Set(dependencies.map((dependency) => getInstallDependencySpecifier(config, dependency))),
  ];
  spawnSync(
    packageManager,
    ['add', ...(dev ? ['-D'] : []), ...(config.isBun ? ['--exact'] : []), ...dependencySpecifiers],
    config.dirPath
  );
}

function addPackageJsonDependencies(
  config: PackageConfig,
  jsonObj: WritablePackageJson,
  packageJsonDependencies: Partial<Record<string, string>>,
  dependencies: string[],
  skipAddingDeps: boolean
): string[] {
  const dependenciesToInstall: string[] = [];
  for (const dependency of new Set(dependencies)) {
    const shouldUpdateExistingDependency = shouldUpdateExistingManagedDependency(
      config,
      dependency,
      packageJsonDependencies[dependency]
    );
    if (shouldUpdateExistingDependency) {
      dependenciesToInstall.push(dependency);
      if (!skipAddingDeps) continue;
    }
    if (
      packageJsonDependencies[dependency] &&
      !shouldUpdateExistingDependency &&
      packageJsonDependencies[dependency] !== '*'
    )
      continue;
    const latestVersion = getLatestDependencyVersion(config, dependency);
    if (latestVersion === '*' && packageJsonDependencies[dependency]) continue;
    packageJsonDependencies[dependency] = latestVersion;
  }
  return dependenciesToInstall;
}

function formatPackageJsonWithProjectFormatter(
  config: PackageConfig,
  packageManager: 'bun' | 'yarn',
  filePath: string
): void {
  const relativeFilePath = path.relative(config.dirPath, filePath);
  if (!relativeFilePath) return;

  // Reuse the target repository's own formatter after dependency installation so
  // package.json matches whatever its current sort-package-json version expects.
  // This avoids follow-up autofix commits caused only by formatter version drift
  // between wbfy and the project being updated.
  if (packageManager === 'bun') {
    spawnSync('bunx', ['sort-package-json', relativeFilePath], config.dirPath);
  } else {
    spawnSync(packageManager, ['sort-package-json', relativeFilePath], config.dirPath);
  }
}

// TODO: remove the following migration code in future
async function removeDeprecatedStuff(
  config: PackageConfig,
  jsonObj: SetRequired<PackageJson, 'scripts' | 'dependencies' | 'devDependencies' | 'peerDependencies'>
): Promise<void> {
  if (jsonObj.author === 'WillBooster LLC') {
    jsonObj.author = 'WillBooster Inc.';
  }
  removeSelfDependency(config, jsonObj);
  replaceWillBoosterConfigsWorkspaceDependencyRanges(config, jsonObj);
  delete jsonObj.scripts['sort-package-json'];
  delete jsonObj.scripts['sort-all-package-json'];
  delete jsonObj.scripts['check-all-for-ai'];
  delete jsonObj.scripts['check-for-ai'];
  delete jsonObj.scripts['typecheck/warn'];
  delete jsonObj.scripts['typecheck:gen-code'];
  delete jsonObj.scripts['typecheck:codegen'];
  delete jsonObj.dependencies.tslib;
  delete jsonObj.devDependencies['@willbooster/renovate-config'];
  delete jsonObj.devDependencies['@willbooster/tsconfig'];
  // Drop `@typescript/native-preview` (tsgo) here so non-Next.js repos never carry it;
  // this runs before applyPackageJsonConventions, which re-adds it for Next.js-family
  // repos that need it alongside the `typescript` v7 package for `next build`.
  delete jsonObj.dependencies[typescriptGoDependency];
  delete jsonObj.devDependencies[typescriptGoDependency];
  // Non-TypeScript repos should not keep a stray `typescript` package.
  if (!config.doesContainTypeScript && !config.doesContainTypeScriptInPackages) {
    delete jsonObj.dependencies[typescriptDependency];
    delete jsonObj.devDependencies[typescriptDependency];
  }
  delete jsonObj.devDependencies.lerna;
  // To install the latest pinst
  delete jsonObj.devDependencies.pinst;
  delete jsonObj.scripts['flutter-format'];
  delete jsonObj.scripts['format-flutter'];
  delete jsonObj.scripts['python-format'];
  delete jsonObj.scripts['format-python'];
  delete jsonObj.scripts.prettier;
  delete jsonObj.scripts['check-all'];
  delete jsonObj.scripts['verify-code'];
  delete jsonObj.scripts['verify-code-with-tests'];
  await promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'lerna.json'), { force: true }));

  removeWillBoosterConfigsManagedDependencies(config, jsonObj);
  removeObsoleteLintDependencies(jsonObj, config);
}

function removeSelfDependency(
  config: PackageConfig,
  jsonObj: SetRequired<PackageJson, 'dependencies' | 'devDependencies' | 'peerDependencies'>
): void {
  const packageName = jsonObj.name || path.basename(config.dirPath);

  // A package can import itself through Node's package self-reference without
  // declaring itself; keeping that edge breaks monorepo release topological sorting.
  for (const section of getDependencySections(jsonObj)) {
    Reflect.deleteProperty(section, packageName);
  }
}

function replaceWillBoosterConfigsWorkspaceDependencyRanges(config: PackageConfig, jsonObj: PackageJson): void {
  if (!config.isWillBoosterConfigs) return;

  for (const section of getDependencySections(jsonObj)) {
    for (const [dependency, version] of Object.entries(section)) {
      if (!version) continue;
      if (!isWorkspaceProtocolRange(version)) continue;
      // willbooster-configs publishes these packages independently, so generated
      // package metadata must describe npm release edges instead of local
      // workspace edges that release tooling treats as monorepo graph links.
      // The final `yarn install --no-immutable` syncs the lockfile after this
      // migration, even when the dependency is not part of wbfy's managed list.
      section[dependency] = getLatestDependencyVersion(config, dependency);
    }
  }
}

function removeWillBoosterConfigsManagedDependencies(
  config: PackageConfig,
  jsonObj: SetRequired<PackageJson, 'dependencies' | 'devDependencies' | 'peerDependencies'>
): void {
  if (!config.isWillBoosterConfigs) return;

  const sections = getDependencySections(jsonObj);
  for (const dependency of willBoosterConfigsManagedDependencies) {
    // willbooster-configs owns these config packages. Package-local formatter
    // and linter config files are repo tooling, not published package data, so
    // the package metadata only needs the formatter/linter executables.
    for (const section of sections) {
      Reflect.deleteProperty(section, dependency);
    }
  }
}

async function removeUnusedTsconfigBaseDependencies(
  config: PackageConfig,
  jsonObj: WritablePackageJson,
  usedDependencies: string[]
): Promise<void> {
  const usedDependencySet = new Set(usedDependencies);
  const existingTsconfigBaseDependencies = await getExistingTsconfigBaseDependencies(config);
  for (const dependency of managedTsconfigBaseDependencies) {
    if (usedDependencySet.has(dependency) || existingTsconfigBaseDependencies.has(dependency)) continue;
    // wbfy owns these base-config packages. Remove stale variants when repo
    // capabilities change, such as Next.js taking ownership of tsconfig.json.
    for (const section of getDependencySections(jsonObj)) {
      Reflect.deleteProperty(section, dependency);
    }
  }
}

async function getExistingTsconfigBaseDependencies(config: PackageConfig): Promise<Set<string>> {
  const existingTsconfigBaseDependencies = new Set<string>();
  const filePaths = await fg.glob('**/tsconfig*.json', {
    cwd: config.dirPath,
    dot: true,
    ignore: globIgnore,
  });

  for (const filePath of filePaths) {
    const absoluteFilePath = path.resolve(config.dirPath, filePath);
    // TypeScript 7's native compiler dropped the in-process `parseConfigFileTextToJson`
    // helper, so parse the tsconfig into an AST and read its top-level `extends` directly.
    const source = parseSourceFile(absoluteFilePath);
    if (!source) {
      console.warn(`Preserve managed @tsconfig dependencies because ${absoluteFilePath} could not be parsed.`);
      return new Set(managedTsconfigBaseDependencies);
    }
    for (const value of readTsconfigExtends(source)) {
      for (const dependency of managedTsconfigBaseDependencies) {
        if (value === dependency || value.startsWith(`${dependency}/`)) {
          existingTsconfigBaseDependencies.add(dependency);
        }
      }
    }
  }

  return existingTsconfigBaseDependencies;
}

/** Reads the top-level `extends` entries (a string or array of strings) from a parsed tsconfig. */
function readTsconfigExtends(source: ast.SourceFile): string[] {
  const values: string[] = [];
  for (const property of getTsconfigRootProperties(source)) {
    if (ast.isPropertyAssignment(property) && ast.isStringLiteral(property.name) && property.name.text === 'extends') {
      collectStringLiteralValues(property.initializer, values);
    }
  }
  return values;
}

function getTsconfigRootProperties(source: ast.SourceFile): readonly ast.ObjectLiteralElementLike[] {
  for (const statement of source.statements) {
    if (ast.isExpressionStatement(statement) && ast.isObjectLiteralExpression(statement.expression)) {
      return statement.expression.properties;
    }
  }
  return [];
}

function collectStringLiteralValues(node: ast.Expression, values: string[]): void {
  if (ast.isStringLiteral(node)) {
    values.push(node.text);
  } else if (ast.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      collectStringLiteralValues(element, values);
    }
  }
}

function getDependencySections(jsonObj: PackageJson): Partial<Record<string, string>>[] {
  return dependencySectionKeys
    .map((key) => jsonObj[key])
    .filter((section): section is Partial<Record<string, string>> => !!section);
}

function getLatestDependencyVersion(config: PackageConfig, dependency: string): string {
  const cacheKey = `${config.isBun ? 'bun' : 'yarn'}:${dependency}`;
  const cachedVersion = latestDependencyVersionCache.get(cacheKey);
  if (cachedVersion) return cachedVersion;

  const version = getDependencyVersionFromNpm(config, dependency);
  latestDependencyVersionCache.set(cacheKey, version);
  return version;
}

function getDependencyVersionFromNpm(config: PackageConfig, dependency: string): string {
  // wbfy-managed tooling (preapproved packages) adopts the latest release immediately,
  // bypassing the minimum-release-age gate applied to unreviewed dependencies.
  if (!shouldApplyPackageAgeGate(config, dependency)) {
    return getRawDependencyVersionFromNpm(dependency);
  }

  return getLatestAgeGatedDependencyVersion(dependency, getPackageAgeGateMs(config));
}

function getLatestAgeGatedDependencyVersion(dependency: string, packageAgeGateMs: number): string {
  const times = getNpmPackageTimes(dependency);
  const latestVersion = getRawDependencyVersionFromNpm(dependency);
  if (latestVersion !== '*' && isPublishedBeforeAgeGate(times[latestVersion], packageAgeGateMs)) {
    return latestVersion;
  }

  const now = Date.now();
  const versions = Object.entries(times)
    .filter(([version]) => semver.valid(version))
    .filter(([version]) => (semver.prerelease(version)?.length ?? 0) === 0)
    .filter(([, publishedAt]) => Number.isFinite(Date.parse(publishedAt)))
    .filter(([, publishedAt]) => now - Date.parse(publishedAt) >= packageAgeGateMs)
    .toSorted(([versionA], [versionB]) => semver.rcompare(versionA, versionB));

  return versions[0]?.[0] ?? '*';
}

function isPublishedBeforeAgeGate(publishedAt: string | undefined, packageAgeGateMs: number): boolean {
  if (!publishedAt) return false;
  const publishedTime = Date.parse(publishedAt);
  return Number.isFinite(publishedTime) && Date.now() - publishedTime >= packageAgeGateMs;
}

function getNpmPackageTimes(dependency: string): Record<string, string> {
  const packageName = dependency.replace(/@[^@/]+$/u, '');
  const cachedTimes = npmPackageTimesCache.get(packageName);
  if (cachedTimes) return cachedTimes;

  const stdout = spawnSyncAndReturnStdout(
    'npm',
    ['show', packageName, 'time', '--json', '--workspaces=false'],
    process.cwd()
  );
  if (!stdout) return {};

  try {
    const parsed = JSON.parse(stdout) as Record<string, string>;
    npmPackageTimesCache.set(packageName, parsed);
    return parsed;
  } catch {
    return {};
  }
}

function shouldApplyPackageAgeGate(config: PackageConfig, dependency: string): boolean {
  const preapprovedPackages = config.isBun ? bunMinimumReleaseAgeExcludes : yarnNpmPreapprovedPackages;
  return !preapprovedPackages.some((pattern) => doesPackagePatternMatch(pattern, dependency));
}

function getPackageAgeGateMs(config: PackageConfig): number {
  if (config.isBun) return bunMinimumReleaseAgeSeconds * 1000;

  const matched = /^(?<days>\d+)d$/u.exec(yarnNpmMinimalAgeGate);
  return Number(matched?.groups?.days ?? 0) * 24 * 60 * 60 * 1000;
}

function doesPackagePatternMatch(pattern: string, dependency: string): boolean {
  if (pattern === dependency) return true;
  if (!pattern.includes('*')) return false;

  const escapedPattern = pattern.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`).replaceAll('*', '.*');
  return new RegExp(`^${escapedPattern}$`, 'u').test(dependency);
}

function getRawDependencyVersionFromNpm(dependency: string): string {
  return spawnSyncAndReturnStdout('npm', ['show', dependency, 'version', '--workspaces=false'], process.cwd()) || '*';
}

function getInstallDependencySpecifier(config: PackageConfig, dependency: string): string {
  if (dependency === wbDependency) return `${dependency}@${getLatestDependencyVersion(config, dependency)}`;
  return dependency;
}

function removeObsoleteLintDependencies(
  jsonObj: SetRequired<PackageJson, 'dependencies' | 'devDependencies' | 'peerDependencies'>,
  config: PackageConfig
): void {
  const preserveMicromatch = shouldPreserveMicromatch(config);
  for (const dependency of obsoleteLintDependencies) {
    if (preserveMicromatch && micromatchPackageNames.has(dependency)) continue;
    if (shouldPreserveConfigPackageLintDependency(jsonObj, config, dependency)) continue;
    delete jsonObj.dependencies[dependency];
    delete jsonObj.devDependencies[dependency];
    delete jsonObj.peerDependencies[dependency];
  }
}

function shouldPreserveConfigPackageLintDependency(
  jsonObj: SetRequired<PackageJson, 'dependencies' | 'devDependencies' | 'peerDependencies'>,
  config: PackageConfig,
  dependency: string
): boolean {
  if (!isPublishedWillboosterConfigsPackage(config)) return false;
  if (jsonObj.peerDependencies[dependency]) return true;

  // Published config packages need local type-only deps to validate the
  // package-provided config declarations under Yarn PnP.
  return dependency === '@types/eslint' && !!jsonObj.peerDependencies.eslint;
}

function shouldPreserveMicromatch(config: PackageConfig): boolean {
  // willbooster-configs subpackages publish config files as their product, so
  // micromatch is package data there. Other repos keep micromatch only when
  // product code imports it; otherwise it is treated as obsolete ESLint-era
  // tooling.
  return (config.isWillBoosterConfigs && !config.isRoot) || doesProductCodeImportMicromatch(config.dirPath);
}

function doesProductCodeImportMicromatch(dirPath: string): boolean {
  const filePaths = fg.globSync('src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}', {
    cwd: dirPath,
    dot: true,
    ignore: globIgnore,
  });
  return filePaths.some((filePath) => {
    try {
      return micromatchImportPattern.test(fs.readFileSync(path.resolve(dirPath, filePath), 'utf8'));
    } catch {
      return false;
    }
  });
}

function shouldUpdateExistingManagedDependency(
  config: PackageConfig,
  dependency: string,
  currentVersion: string | undefined
): boolean {
  if (!currentVersion) return true;
  if (currentVersion === '*') return true;
  if (isWorkspaceProtocolRange(currentVersion)) return true;
  // wbfy owns these tool dependencies, but applying wbfy should not downgrade a
  // repository that already pins a newer reviewed release.
  return managedDependencyNames.has(dependency) && isNewerManagedDependencyVersion(config, dependency, currentVersion);
}

function isNewerManagedDependencyVersion(config: PackageConfig, dependency: string, currentVersion: string): boolean {
  const latestVersion = getLatestDependencyVersion(config, dependency);
  return isNewerPackageVersion(latestVersion, currentVersion);
}

function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
  const validLatestVersion = semver.valid(candidateVersion);
  const validCurrentVersion = semver.valid(currentVersion);
  return !validLatestVersion || !validCurrentVersion || semver.gt(validLatestVersion, validCurrentVersion);
}

function isWorkspaceProtocolRange(version: string): boolean {
  return version.startsWith('workspace:');
}

function formatRepositoryForPackageJson(
  repository: PackageJson['repository'],
  existingRepository?: PackageJson['repository']
): PackageJson['repository'] {
  const normalizedRepository = normalizeRepositoryUrlForPackageJson(repository);
  if (normalizedRepository) {
    return buildNormalizedRepositoryForPackageJson(normalizedRepository, repository, existingRepository);
  }

  const normalizedExistingRepository = normalizeRepositoryUrlForPackageJson(existingRepository);
  if (normalizedExistingRepository) {
    return buildNormalizedRepositoryForPackageJson(normalizedExistingRepository, existingRepository);
  }

  return repository;
}

function normalizeRepositoryUrlForPackageJson(repository: PackageJson['repository']): string | undefined {
  if (typeof repository === 'string') {
    if (!repository.startsWith('github:')) return;

    const [owner, repo] = gitHubUtil.getOrgAndName(repository);
    if (!owner || !repo) return;
    return `git+https://github.com/${owner}/${repo}.git`;
  }

  const repositoryUrl = repository?.url;
  if (typeof repositoryUrl !== 'string') return;

  const matched = /^(?:git\+)?https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(repositoryUrl);
  if (!matched) return;

  const [, owner, repo] = matched;
  return `git+https://github.com/${owner}/${repo}.git`;
}

function buildNormalizedRepositoryForPackageJson(
  normalizedUrl: string,
  repository: PackageJson['repository'],
  existingRepository?: PackageJson['repository']
): PackageJson['repository'] {
  const repositoryObj =
    typeof repository === 'object'
      ? repository
      : typeof existingRepository === 'object'
        ? existingRepository
        : undefined;

  return {
    ...repositoryObj,
    type: 'git',
    url: normalizedUrl,
  };
}

export function generateScripts(config: PackageConfig, oldScripts: PackageJson.Scripts): Record<string, string> {
  if (config.isBun) {
    const hasTypecheck = config.doesContainTypeScript || config.doesContainTypeScriptInPackages;
    const scripts: Record<string, string> = {
      // No `--bun`: its node->bun PATH shim leaks into every child process and breaks tools
      // requiring real Node.js (Playwright, wrangler, vinext).
      cleanup: 'bun wb lint --fix --format',
      format: `bun wb lint --format`,
      lint: `bun wb lint`,
      'lint-fix': 'bun wb lint --fix',
      test: 'bun wb test',
      typecheck: 'bun wb typecheck',
      verify: 'bun wb verify',
      'verify-full': 'bun wb verify --full',
    };
    applyDatabaseScripts(config, scripts, oldScripts, `bun ${getWbDatabaseCommand(config)}`);
    applyMiseTaskScripts(config, scripts, oldScripts, ['build', 'dev', 'start', 'test', 'typecheck']);
    if (!hasTypecheck) {
      delete scripts.typecheck;
    } else if (config.depending.pyright) {
      scripts.typecheck += ' && pyright';
    }
    return scripts;
  } else {
    const hasTypecheck = config.doesContainTypeScript || config.doesContainTypeScriptInPackages;
    const hasJsOrTs = doesContainJsOrTs(config);
    const hasJava = doesContainJava(config);
    const oldTest = oldScripts.test;
    let scripts: Record<string, string> = {
      cleanup: 'yarn format && yarn lint-fix',
      format: generateFormatScript(hasJsOrTs, hasJava),
      // Package-local configs must delete the root-only type-aware options, so pass the flags
      // explicitly. Otherwise this script would silently skip type checking in workspace packages.
      lint: `oxlint${hasTypecheck ? ' --type-aware --type-check' : ''} --no-error-on-unmatched-pattern .`,
      'lint-fix': 'yarn lint --fix',
      'format-code': `oxfmt --write --no-error-on-unmatched-pattern . '!**/package.json'`,
      typecheck: 'tsc --noEmit',
    };
    if (hasJava) {
      scripts.prettify = `prettier --cache --no-error-on-unmatched-pattern --write "**/{.*/,}*.{${extensions.prettierOnly.join(',')}}" "!**/test{-,/}fixtures/**"`;
    }
    if (config.doesContainSubPackageJsons) {
      scripts = merge(
        { ...scripts },
        {
          format: `${scripts.format} && yarn workspaces foreach --all --parallel --verbose run format`,
          lint: `yarn workspaces foreach --all --parallel --verbose run lint`,
          'lint-fix': 'yarn workspaces foreach --all --parallel --verbose run lint-fix',
          // CI=1 prevents vitest from enabling watch. Color policy belongs to wb, not generated package scripts.
          test: 'CI=1 yarn workspaces foreach --all --verbose run test',
          typecheck: 'yarn workspaces foreach --all --parallel --verbose run typecheck',
        }
      );
      if (hasJava) {
        scripts.prettify = `prettier --cache --no-error-on-unmatched-pattern --write "**/{.*/,}*.{${extensions.prettierOnly.join(
          ','
        )}}" "!**/packages/**" "!**/test{-,/}fixtures/**"`;
      }
    } else if (config.depending.pyright) {
      scripts.typecheck = scripts.typecheck ? `${scripts.typecheck} && ` : '';
      scripts.typecheck += 'pyright';
    }
    if (oldTest?.includes('wb test')) {
      scripts.test = oldTest;
    }
    if (!hasJsOrTs) {
      delete scripts['format-code'];
      delete scripts.lint;
      delete scripts['lint-fix'];
    }
    if (!hasTypecheck) {
      delete scripts.typecheck;
    } else if (config.depending.wb) {
      scripts.typecheck = 'wb typecheck';
    }
    if (isWbPackage(config.packageJson)) {
      scripts.verify = oldScripts.verify ?? 'yarn workspace @willbooster/wb start --working-dir "$INIT_CWD" verify';
      scripts['verify-full'] = oldScripts['verify-full'] ?? 'yarn verify --full';
    } else {
      scripts.verify = 'wb verify';
      scripts['verify-full'] = 'wb verify --full';
    }
    applyDatabaseScripts(config, scripts, oldScripts, getWbDatabaseCommand(config));
    applyMiseTaskScripts(config, scripts, oldScripts, ['build', 'dev', 'start', 'test', 'typecheck']);
    return scripts;
  }
}

function shouldManageGenI18nTs(config: PackageConfig): boolean {
  return config.depending.genI18nTs && fs.existsSync(path.join(config.dirPath, 'i18n'));
}

function applyDatabaseScripts(
  config: PackageConfig,
  scripts: Record<string, string>,
  oldScripts: PackageJson.Scripts,
  wbDbCommand: string
): void {
  if (!config.depending.prisma && !config.depending.drizzle) return;

  applyDatabaseScript(scripts, oldScripts, 'db-create-migration', `${wbDbCommand} migrate-dev`);
  applyDatabaseScript(scripts, oldScripts, 'db-migrate', `${wbDbCommand} migrate --check-idempotency`);
  applyDatabaseScript(scripts, oldScripts, 'db-view', `${wbDbCommand} studio`);
}

function applyDatabaseScript(
  scripts: Record<string, string>,
  oldScripts: PackageJson.Scripts,
  name: string,
  generatedScript: string
): void {
  const oldScript = oldScripts[name];
  // Some repositories wrap migration commands to prepare SQLite directories,
  // fan out over tenants, or perform cleanup that wb cannot infer generically.
  scripts[name] = oldScript && !isGeneratedDatabaseScript(oldScript) ? oldScript : generatedScript;
}

function isGeneratedDatabaseScript(script: string): boolean {
  return /\bwb\s+(?:db|prisma)\b/u.test(script);
}

function getWbDatabaseCommand(config: PackageConfig): 'wb db' | 'wb prisma' {
  if (config.depending.prisma) return 'wb prisma';
  return 'wb db';
}

function isWbPackage(packageJson: PackageJson | undefined): boolean {
  return packageJson?.name === wbDependency;
}

function applyMiseTaskScripts(
  config: PackageConfig,
  scripts: Record<string, string>,
  oldScripts: PackageJson.Scripts,
  names: string[]
): void {
  for (const name of names) {
    if (!hasMiseTask(config, name)) continue;
    if (doesMiseTaskCallPackageScript(config, name)) continue;
    // Preserve a leading `KEY=VALUE ` env prefix (e.g. `MISE_ENV=test`) on an existing mise bridge.
    // Such a prefix is required for mise config environments (mise.<MISE_ENV>.toml), which are
    // selected from MISE_ENV *before* mise starts and cannot be switched from inside a task; dropping
    // it would silently run the task in the default environment.
    const envPrefix = extractMiseBridgeEnvPrefix(oldScripts[name], name);
    if (envPrefix === undefined && oldScripts[name] && !(name in scripts)) continue;
    scripts[name] = `${envPrefix ?? ''}mise run ${name}`;
  }
}

/**
 * Returns the leading `KEY=VALUE ` env-var prefix of an existing `mise run <name>` bridge script
 * (possibly an empty string when the bridge has no prefix), or `undefined` when the script is not a
 * mise bridge for the given task.
 */
function extractMiseBridgeEnvPrefix(script: unknown, name: string): string | undefined {
  if (typeof script !== 'string') return undefined;
  // Each assignment value may be double-quoted, single-quoted, or an unquoted run of non-whitespace,
  // so prefixes like `MISE_ENV="a b"` (whose value contains spaces) are matched instead of dropped.
  const match = new RegExp(String.raw`^((?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)*)mise run ${escapeRegExp(name)}$`, 'u').exec(
    script.trim()
  );
  return match?.[1];
}

function hasMiseTask(config: PackageConfig, name: string): boolean {
  return Object.hasOwn(config.miseTasks, name);
}

function doesMiseTaskCallPackageScript(config: PackageConfig, name: string): boolean {
  const task = config.miseTasks[name];
  if (!task) return false;
  const packageManagers = ['bun', 'yarn', 'npm', 'pnpm'];
  return packageManagers.some((packageManager) =>
    new RegExp(String.raw`\b${packageManager}\s+(?:run\s+)?${escapeRegExp(name)}(?![a-zA-Z0-9_\-:.])`, 'u').test(task)
  );
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function generateFormatScript(hasJsOrTs: boolean, hasJava: boolean): string {
  const commands = ['sort-package-json'];
  if (hasJsOrTs) {
    commands.push('yarn format-code');
  }
  if (hasJava) {
    commands.push('yarn prettify');
  }
  return commands.join(' && ');
}

async function generatePrettierSuffix(dirPath: string): Promise<string> {
  const filePath = path.resolve(dirPath, '.prettierignore');
  const existingContent = await fs.promises.readFile(filePath, 'utf8').catch(() => '');
  const index = existingContent.indexOf(ignoreFileUtil.separatorPrefix);
  if (index === -1) return '';

  const originalContent = existingContent.slice(0, index);
  const lines = originalContent
    .split('\n')
    .map((line) => {
      const newLine = line.trim();
      return newLine.endsWith('/') ? newLine.slice(0, -1) : newLine;
    })
    .filter((l) => l && !l.startsWith('#') && !l.includes('/'));

  return `${lines.map((line) => ` "!**/${line}/**"`).join('')} || true`;
}

function removePrettierArtifacts(jsonObj: WritablePackageJson): void {
  delete jsonObj.prettier;
  const dependencySections: Array<Partial<Record<string, string>> | undefined> = [
    jsonObj.dependencies,
    jsonObj.devDependencies,
    jsonObj.peerDependencies,
  ];
  for (const section of dependencySections) {
    if (!section) continue;
    delete section.prettier;
    delete section['prettier-plugin-java'];
    delete section['prettier-plugin-prisma'];
    delete section['@willbooster/prettier-config'];
    delete section['@types/prettier'];
  }
}

async function updatePrivatePackages(jsonObj: WritablePackageJson): Promise<void> {
  const packageNames = new Set([...Object.keys(jsonObj.dependencies), ...Object.keys(jsonObj.devDependencies)]);
  const privatePackages: {
    packageName: string;
    repo: string;
    target: 'dependencies' | 'devDependencies';
  }[] = [
    { packageName: '@willbooster/auth', repo: 'auth', target: 'dependencies' },
    { packageName: '@discord-bot/shared', repo: 'discord-bot', target: 'dependencies' },
    { packageName: '@willbooster/code-analyzer', repo: 'code-analyzer', target: 'devDependencies' },
    { packageName: '@willbooster/judge', repo: 'judge', target: 'dependencies' },
    { packageName: '@willbooster/llm-proxy', repo: 'llm-proxy', target: 'dependencies' },
  ];

  await Promise.all(
    privatePackages.map(async ({ packageName, repo, target }) => {
      if (!packageNames.has(packageName) || isWorkspacePackage(jsonObj, packageName)) return;

      const otherTarget = target === 'dependencies' ? 'devDependencies' : 'dependencies';
      // The lint rule disallows `delete` with computed package names; Reflect has the same deletion semantics here.
      Reflect.deleteProperty(jsonObj[otherTarget], packageName);
      jsonObj[target][packageName] = await getLatestPrivatePackageSpecifier(repo);
    })
  );
}

async function getLatestPrivatePackageSpecifier(repo: string): Promise<string> {
  const commitHash = await getLatestCommitHash('WillBoosterLab', repo);
  return `git@github.com:WillBoosterLab/${repo}.git#${commitHash}`;
}

function isWorkspacePackage(jsonObj: PackageJson, packageName: string): boolean {
  return (jsonObj.devDependencies?.[packageName] || jsonObj.dependencies?.[packageName] || '').includes('workspace');
}
