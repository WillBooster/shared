import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import fg from 'fast-glob';
import { sortPackageJson } from 'sort-package-json';
import ts from 'typescript';
import type { PackageJson, SetRequired } from 'type-fest';

import { getLatestCommitHash } from '../github/commit.js';
import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { extensions } from '../utils/extensions.js';
import { fsUtil } from '../utils/fsUtil.js';
import { getGenI18nTsCommand } from '../utils/genI18nTs.js';
import { gitHubUtil } from '../utils/githubUtil.js';
import { globIgnore } from '../utils/globUtil.js';
import { ignoreFileUtil } from '../utils/ignoreFileUtil.js';
import { combineMerge } from '../utils/mergeUtil.js';
import { doesContainJava, doesContainJsOrTs } from '../utils/packageCapabilities.js';
import { promisePool } from '../utils/promisePool.js';
import { spawnSync, spawnSyncAndReturnStdout } from '../utils/spawnUtil.js';
import { getTsconfigBaseDependencies, managedTsconfigBaseDependencies } from '../utils/tsconfigBase.js';
import { isPublishedWillboosterConfigsPackage } from '../utils/willboosterConfigsUtil.js';

const oxlintDeps = ['@willbooster/oxfmt-config', '@willbooster/oxlint-config', 'oxfmt', 'oxlint', 'oxlint-tsgolint'];
const typescriptGoDependency = '@typescript/native-preview';
const typescriptDependency = 'typescript';
const wbDependency = '@willbooster/wb';
const buildTsDependency = 'build-ts';
const willBoosterConfigsManagedDependencies = [
  '@willbooster/prettier-config',
  wbDependency,
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
  await updateScripts(config, jsonObj, packageManager);
  moveManagedToolDependenciesToDevDependencies(jsonObj);
  const dependencyUpdates = await applyPackageJsonConventions(config, rootConfig, jsonObj);
  await normalizePackageMetadata(config, rootConfig, jsonObj, dependencyUpdates);
  addDependencyVersionsToPackageJson(jsonObj, dependencyUpdates);
  await updatePrivatePackages(jsonObj);
  removeEmptyDependencySections(jsonObj);

  if (config.isBun) delete jsonObj.packageManager;
  // Yarn reads package.json from disk before deciding whether `yarn add -D`
  // conflicts with an existing regular dependency, so this write must finish
  // before installing the managed dependency updates below. Keep this baseline
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

async function updateScripts(
  config: PackageConfig,
  jsonObj: WritablePackageJson,
  packageManager: 'bun' | 'yarn'
): Promise<void> {
  removeLegacyInstallCommands(jsonObj.scripts);

  jsonObj.scripts = { ...jsonObj.scripts, ...generateScripts(config, jsonObj.scripts) };
  addStartTestServerScriptIfNeeded(config, jsonObj);
  addInstallStepToCheckForAi(jsonObj.scripts, packageManager);

  const scripts = jsonObj.scripts;
  if (config.isBun || !doesContainJava(config)) {
    delete scripts.prettify;
  } else {
    scripts.prettify = (scripts.prettify ?? '') + (await generatePrettierSuffix(config.dirPath));
  }
  normalizeYarnWorkspaceForeachScripts(scripts);
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

function addInstallStepToCheckForAi(scripts: PackageJson.Scripts, packageManager: 'bun' | 'yarn'): void {
  if (!('check-for-ai' in scripts)) return;

  if ('gen-code' in scripts) {
    scripts['check-for-ai'] = `${packageManager} gen-code > /dev/null && ${scripts['check-for-ai']}`;
  }
  scripts['check-for-ai'] = `${packageManager} install > /dev/null && ${scripts['check-for-ai']}`;
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
    delete jsonObj.scripts.postinstall;
    delete jsonObj.scripts.postpublish;
    delete jsonObj.scripts.prepublishOnly;
    delete jsonObj.scripts.prepack;
    delete jsonObj.scripts.postpack;
    jsonObj.scripts.prepare = 'lefthook install || true';
    devDependencies.push('lefthook');

    if (config.depending.semanticRelease) {
      if (
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
      delete jsonObj.dependencies.playwright;
      delete jsonObj.devDependencies.playwright;
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

  if (config.depending.wb || config.isBun) {
    devDependencies.push(wbDependency);
    for (const [key, value] of Object.entries(jsonObj.scripts)) {
      if (typeof value !== 'string') continue;
      jsonObj.scripts[key] = value.replaceAll(/wb\s+db/gu, 'wb prisma');
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
    devDependencies.push(buildTsDependency);
  }
  if (doesContainJsOrTs(config)) {
    devDependencies.push(...oxlintDeps);
  }

  const tsconfigBaseDependencies = doesContainJsOrTs(config) ? getTsconfigBaseDependencies(config) : [];
  await removeUnusedTsconfigBaseDependencies(config, jsonObj, tsconfigBaseDependencies);
  devDependencies.push(...tsconfigBaseDependencies);

  if (config.doesContainTypeScript || config.doesContainTypeScriptInPackages) {
    devDependencies.push(typescriptGoDependency);
    if (config.depending.next) {
      // Next.js still uses the `typescript` package during dev/build startup for
      // TypeScript apps even when repositories delegate explicit typechecking to tsgo.
      devDependencies.push(typescriptDependency);
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

function moveManagedToolDependenciesToDevDependencies(jsonObj: WritablePackageJson): void {
  for (const dependency of [wbDependency, buildTsDependency]) {
    if (!jsonObj.dependencies[dependency]) continue;
    jsonObj.devDependencies[dependency] ??= jsonObj.dependencies[dependency];
    delete jsonObj.dependencies[dependency];
  }
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
        for (const scriptName of ['cleanup', 'check-for-ai']) {
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
      jsonObj.scripts['common/ci-setup'] = `yarn setup-${pythonPackageManager}`;
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
          jsonObj.scripts['lint-fix'] = 'yarn lint';
        }
        jsonObj.scripts.format = appendFormatCodeCommand(jsonObj.scripts.format, config);
        dependencyUpdates.pythonDevDependencies.push('black', 'isort', 'flake8');
      }
    }
  }

  if (config.repository || jsonObj.repository) {
    jsonObj.repository = formatRepositoryForPackageJson(config.repository ?? jsonObj.repository, jsonObj.repository);
  }

  if (config.depending.blitz) {
    if (!jsonObj.scripts['gen-code']?.startsWith('blitz codegen')) {
      jsonObj.scripts['gen-code'] = 'blitz codegen';
    } else if (!jsonObj.scripts['gen-code'].includes('blitz prisma generate')) {
      jsonObj.scripts['gen-code'] = jsonObj.scripts['gen-code'].replace(
        'blitz codegen',
        'blitz codegen && blitz prisma generate'
      );
    }
  } else if (config.depending.prisma && !jsonObj.scripts['gen-code']?.startsWith('prisma generate')) {
    jsonObj.scripts['gen-code'] = 'prisma generate';
  }
  addGenI18nTsPostinstallScript(config, jsonObj);

  if (!jsonObj.dependencies.prettier) {
    // Because @types/prettier blocks prettier execution.
    delete jsonObj.devDependencies['@types/prettier'];
  }
}

function appendFormatCodeCommand(formatScript: string | undefined, config: PackageConfig): string {
  // Bun projects may not have a Yarn lockfile, so generated package scripts
  // must invoke local package scripts through the repository's package manager.
  const scriptRunner = config.isBun ? 'bun run' : 'yarn';
  return formatScript ? `${formatScript} && ${scriptRunner} format-code` : `${scriptRunner} format-code`;
}

function addGenI18nTsPostinstallScript(config: PackageConfig, jsonObj: WritablePackageJson): void {
  const command = getGenI18nTsCommand(config, jsonObj.scripts);
  if (!command) return;

  const postinstall = jsonObj.scripts.postinstall;
  if (!postinstall) {
    jsonObj.scripts.postinstall = command;
  } else if (!postinstall.includes(command)) {
    jsonObj.scripts.postinstall = `${postinstall} && ${command}`;
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

function addDependencyVersionsToPackageJson(jsonObj: WritablePackageJson, dependencyUpdates: DependencyUpdates): void {
  const packageJsonDependencies = jsonObj.dependencies;
  const packageJsonDevDependencies = jsonObj.devDependencies;
  dependencyUpdates.dependencies = addPackageJsonDependencies(packageJsonDependencies, dependencyUpdates.dependencies);
  dependencyUpdates.devDependencies = dependencyUpdates.devDependencies.filter((dep) => !packageJsonDependencies[dep]);
  dependencyUpdates.devDependencies = addPackageJsonDependencies(
    packageJsonDevDependencies,
    dependencyUpdates.devDependencies
  );
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
  installNpmDependencies(config, packageManager, jsonObj.dependencies ?? {}, dependencies, false);

  const devDependencies = dependencyUpdates.devDependencies.filter((dep) => !jsonObj.dependencies?.[dep]);
  installNpmDependencies(config, packageManager, jsonObj.devDependencies ?? {}, devDependencies, true);

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
  packageJsonDependencies: Partial<Record<string, string>>,
  dependencies: string[],
  dev: boolean
): void {
  if (dependencies.length === 0) return;

  const dependencySpecifiers = [
    ...new Set(
      dependencies.map((dependency) =>
        getInstallDependencySpecifier(dependency, packageJsonDependencies[dependency], packageManager)
      )
    ),
  ];
  spawnSync(
    packageManager,
    ['add', ...(dev ? ['-D'] : []), ...(config.isBun ? ['--exact'] : []), ...dependencySpecifiers],
    config.dirPath
  );
}

function getInstallDependencySpecifier(
  dependency: string,
  currentVersion: string | undefined,
  packageManager: 'bun' | 'yarn'
): string {
  // Yarn prefers local workspaces when adding a bare package name. Passing the
  // resolved version keeps managed tools as npm dependencies in config-package
  // monorepos, where those package names can also exist as workspaces.
  if (packageManager === 'yarn' && currentVersion && !isWorkspaceProtocolRange(currentVersion)) {
    return `${dependency}@${currentVersion}`;
  }

  return getDependencySpecifier(dependency);
}

function addPackageJsonDependencies(
  packageJsonDependencies: Partial<Record<string, string>>,
  dependencies: string[]
): string[] {
  const dependenciesToInstall: string[] = [];
  for (const dependency of new Set(dependencies)) {
    const shouldUpdateExistingDependency = shouldUpdateExistingManagedDependency(
      dependency,
      packageJsonDependencies[dependency]
    );
    if (shouldUpdateExistingDependency) {
      dependenciesToInstall.push(dependency);
    }
    if (
      packageJsonDependencies[dependency] &&
      !shouldUpdateExistingDependency &&
      packageJsonDependencies[dependency] !== '*'
    )
      continue;
    packageJsonDependencies[dependency] = getLatestDependencyVersion(dependency);
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
  delete jsonObj.scripts['typecheck/warn'];
  delete jsonObj.scripts['typecheck:gen-code'];
  delete jsonObj.scripts['typecheck:codegen'];
  delete jsonObj.dependencies.tslib;
  delete jsonObj.devDependencies['@willbooster/renovate-config'];
  delete jsonObj.devDependencies['@willbooster/tsconfig'];
  // Next.js still requires the `typescript` package at build/dev time for
  // TypeScript projects even when repos use tsgo for explicit typechecking.
  if (!config.depending.next) {
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
      section[dependency] = getLatestDependencyVersion(dependency);
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
    // willbooster-configs publishes these managed config packages from the same
    // monorepo. Keeping them in subpackage metadata creates local workspace
    // graph edges that multi-semantic-release sorts as release dependencies.
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
    try {
      const parsed = ts.parseConfigFileTextToJson(
        absoluteFilePath,
        await fs.promises.readFile(absoluteFilePath, 'utf8')
      );
      if (parsed.error) {
        console.warn(
          `Preserve managed @tsconfig dependencies because ${absoluteFilePath} could not be parsed: ${formatTsDiagnostic(parsed.error)}`
        );
        return new Set(managedTsconfigBaseDependencies);
      }
      for (const value of normalizeTsconfigExtends((parsed.config as { extends?: unknown } | undefined)?.extends)) {
        for (const dependency of managedTsconfigBaseDependencies) {
          if (value === dependency || value.startsWith(`${dependency}/`)) {
            existingTsconfigBaseDependencies.add(dependency);
          }
        }
      }
    } catch (error) {
      console.warn(
        `Preserve managed @tsconfig dependencies because ${absoluteFilePath} could not be read: ${error instanceof Error ? error.message : String(error)}`
      );
      return new Set(managedTsconfigBaseDependencies);
    }
  }

  return existingTsconfigBaseDependencies;
}

function formatTsDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function normalizeTsconfigExtends(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function getDependencySections(jsonObj: PackageJson): Partial<Record<string, string>>[] {
  return dependencySectionKeys
    .map((key) => jsonObj[key])
    .filter((section): section is Partial<Record<string, string>> => !!section);
}

function getLatestDependencyVersion(dependency: string): string {
  const cachedVersion = latestDependencyVersionCache.get(dependency);
  if (cachedVersion) return cachedVersion;

  const version = getDependencyVersionFromNpm(dependency);
  latestDependencyVersionCache.set(dependency, version);
  return version;
}

function getDependencyVersionFromNpm(dependency: string): string {
  // npm's latest dist-tag still tracks TS7 dev snapshots; wbfy should follow
  // the public beta channel until the stable TS7 package layout is finalized.
  return (
    spawnSyncAndReturnStdout(
      'npm',
      ['show', getDependencySpecifier(dependency), 'version', '--workspaces=false'],
      process.cwd()
    ) || '*'
  );
}

function getDependencySpecifier(dependency: string): string {
  return dependency === typescriptGoDependency ? `${dependency}@beta` : dependency;
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

function shouldUpdateExistingManagedDependency(dependency: string, currentVersion: string | undefined): boolean {
  if (!currentVersion) return true;
  if (currentVersion === '*') return true;
  if (isWorkspaceProtocolRange(currentVersion)) return true;
  // wbfy-managed tools must be kept current even when the package already pins
  // a concrete version. In particular, build-ts owns declaration output paths.
  return (
    dependency === '@willbooster/wb' ||
    dependency === buildTsDependency ||
    oxlintDeps.includes(dependency) ||
    dependency === typescriptGoDependency
  );
}

function isWorkspaceProtocolRange(version: string): boolean {
  return version.startsWith('workspace:');
}

function addStartTestServerScriptIfNeeded(config: PackageConfig, jsonObj: PackageJson): void {
  if (
    !config.depending.playwrightTest ||
    !(config.depending.wb || config.isBun) ||
    jsonObj.scripts?.['start-test-server']
  ) {
    return;
  }

  jsonObj.scripts ??= {};
  // mise often owns env loading and database preparation for local web servers.
  // Prefer a dedicated non-recursive test-server task before falling back to the generic start task.
  const taskName = getSafeMiseTaskName(config, ['start-test-server', 'start']);
  jsonObj.scripts['start-test-server'] = taskName ? `mise run ${taskName}` : 'wb start --mode test';
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
      'check-all-for-ai': 'bun run check-for-ai && bun run test',
      'check-for-ai': 'bun run cleanup',
      cleanup: 'bun --bun wb lint --fix --format',
      format: `bun --bun wb lint --format`,
      lint: `bun --bun wb lint`,
      'lint-fix': 'bun --bun wb lint --fix',
      test: 'bun wb test',
      typecheck: 'bun --bun wb typecheck',
      verify: 'bun --bun wb verify',
      'verify-full': 'bun --bun wb verify --full',
    };
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
      'check-all-for-ai': 'yarn check-for-ai && yarn test',
      'check-for-ai': `yarn format > /dev/null 2> /dev/null || true && yarn lint-fix --quiet`,
      cleanup: 'yarn format && yarn lint-fix',
      format: generateFormatScript(hasJsOrTs, hasJava),
      lint: `oxlint --no-error-on-unmatched-pattern .`,
      'lint-fix': 'yarn lint --fix',
      'format-code': `oxfmt --write --no-error-on-unmatched-pattern . '!**/package.json'`,
      typecheck: 'tsgo --noEmit',
    };
    if (hasJava) {
      scripts.prettify = `prettier --cache --color --no-error-on-unmatched-pattern --write "**/{.*/,}*.{${extensions.prettierOnly.join(',')}}" "!**/test{-,/}fixtures/**"`;
    }
    if (config.doesContainSubPackageJsons) {
      scripts = merge(
        { ...scripts },
        {
          format: `${scripts.format} && yarn workspaces foreach --all --parallel --verbose run format`,
          lint: `yarn workspaces foreach --all --parallel --verbose run lint`,
          'lint-fix': 'yarn workspaces foreach --all --parallel --verbose run lint-fix',
          // CI=1 prevents vitest from enabling watch.
          // FORCE_COLOR=3 make wb enable color output.
          test: 'CI=1 FORCE_COLOR=3 yarn workspaces foreach --all --verbose run test',
          typecheck: 'yarn workspaces foreach --all --parallel --verbose run typecheck',
        }
      );
      if (hasJava) {
        scripts.prettify = `prettier --cache --color --no-error-on-unmatched-pattern --write "**/{.*/,}*.{${extensions.prettierOnly.join(
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
    if (config.depending.wb) {
      scripts.verify = 'wb verify';
      scripts['verify-full'] = 'wb verify --full';
    }
    applyMiseTaskScripts(config, scripts, oldScripts, ['build', 'dev', 'start', 'test', 'typecheck']);
    return scripts;
  }
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
    if (oldScripts[name] && !isWbfyManagedMiseBridge(oldScripts[name], name) && !(name in scripts)) continue;
    scripts[name] = `mise run ${name}`;
  }
}

function hasMiseTask(config: PackageConfig, name: string): boolean {
  return Object.hasOwn(config.miseTasks, name);
}

function getSafeMiseTaskName(config: PackageConfig, names: string[]): string | undefined {
  return names.find((name) => hasMiseTask(config, name) && !doesMiseTaskCallPackageScript(config, name));
}

function doesMiseTaskCallPackageScript(config: PackageConfig, name: string): boolean {
  const task = config.miseTasks[name];
  if (!task) return false;
  const packageManagers = ['bun', 'yarn', 'npm', 'pnpm'];
  return packageManagers.some((packageManager) =>
    new RegExp(String.raw`\b${packageManager}\s+(?:run\s+)?${escapeRegExp(name)}(?![a-zA-Z0-9_\-:.])`, 'u').test(task)
  );
}

function isWbfyManagedMiseBridge(script: unknown, name: string): boolean {
  return script === `mise run ${name}`;
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
