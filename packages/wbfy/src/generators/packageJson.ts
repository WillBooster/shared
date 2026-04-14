import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import fg from 'fast-glob';
import { sortPackageJson } from 'sort-package-json';
import type { PackageJson, SetRequired } from 'type-fest';

import { getLatestCommitHash } from '../github/commit.js';
import { logger } from '../logger.js';
import type { EslintExtensionBase, PackageConfig } from '../packageConfig.js';
import { EslintUtil } from '../utils/eslintUtil.js';
import { extensions } from '../utils/extensions.js';
import { fsUtil } from '../utils/fsUtil.js';
import { gitHubUtil } from '../utils/githubUtil.js';
import { globIgnore } from '../utils/globUtil.js';
import { ignoreFileUtil } from '../utils/ignoreFileUtil.js';
import { combineMerge } from '../utils/mergeUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { spawnSync } from '../utils/spawnUtil.js';
import { getTsconfigBaseDependencies } from '../utils/tsconfigBase.js';
import { getPinnedDependencySpecifier } from '../utils/willboosterConfigsUtil.js';

const jsCommonDeps = [
  '@eslint/js',
  'eslint',
  'eslint-config-flat-gitignore',
  'eslint-config-prettier',
  'eslint-plugin-import-x',
  'eslint-plugin-sort-class-members',
  'eslint-plugin-sort-destructure-keys',
  'eslint-plugin-unicorn',
  'eslint-plugin-unused-imports',
  'globals',
];

const tsCommonDeps = [...jsCommonDeps, 'typescript-eslint', 'eslint-import-resolver-typescript'];

const reactCommonDeps = [
  '@eslint-react/eslint-plugin',
  'eslint-plugin-perfectionist',
  'eslint-plugin-react-compiler',
  'typescript',
];

const eslintDeps: Record<EslintExtensionBase, string[]> = {
  '@willbooster/eslint-config-js': ['@willbooster/eslint-config-js', ...jsCommonDeps],
  '@willbooster/eslint-config-js-react': ['@willbooster/eslint-config-js-react', ...jsCommonDeps, ...reactCommonDeps],
  '@willbooster/eslint-config-ts': ['@willbooster/eslint-config-ts', ...tsCommonDeps],
  '@willbooster/eslint-config-ts-react': ['@willbooster/eslint-config-ts-react', ...tsCommonDeps, ...reactCommonDeps],
  '@willbooster/eslint-config-next': [
    '@willbooster/eslint-config-next',
    '@next/eslint-plugin-next',
    ...tsCommonDeps,
    ...reactCommonDeps,
  ],
};

type WritablePackageJson = SetRequired<
  PackageJson,
  'scripts' | 'dependencies' | 'devDependencies' | 'peerDependencies'
>;

interface DependencyUpdates {
  dependencies: string[];
  devDependencies: string[];
  poetryDevDependencies: string[];
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

  await removeDeprecatedStuff(jsonObj, config.dirPath);
  await updateScripts(config, jsonObj, packageManager);
  const dependencyUpdates = applyPackageJsonConventions(config, rootConfig, jsonObj);
  await normalizePackageMetadata(config, rootConfig, jsonObj, dependencyUpdates);
  addDependencyVersionsToPackageJson(jsonObj, dependencyUpdates);
  await updatePrivatePackages(jsonObj);
  removeEmptyDependencySections(jsonObj);

  if (config.isBun) delete jsonObj.packageManager;
  await promisePool.run(() => fsUtil.generateFile(filePath, JSON.stringify(sortPackageJson(jsonObj), undefined, 2)));

  if (!skipAddingDeps) {
    installDependencyUpdates(config, jsonObj, dependencyUpdates, packageManager);
  }
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

  if (config.isBun) {
    delete jsonObj.scripts.prettify;
  } else {
    jsonObj.scripts.prettify = (jsonObj.scripts.prettify ?? '') + (await generatePrettierSuffix(config.dirPath));
  }
  normalizeYarnWorkspaceForeachScripts(jsonObj.scripts);
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

function applyPackageJsonConventions(
  config: PackageConfig,
  rootConfig: PackageConfig,
  jsonObj: WritablePackageJson
): DependencyUpdates {
  const dependencies: string[] = [];
  const devDependencies = ['prettier', 'sort-package-json'];
  const poetryDevDependencies: string[] = [];

  if (
    !fs.existsSync(path.join(rootConfig.dirPath, '.prettierrc.json')) &&
    !fs.existsSync(path.join(config.dirPath, '.prettierrc.json'))
  ) {
    jsonObj.prettier = '@willbooster/prettier-config';
    devDependencies.push('prettier-plugin-java', '@willbooster/prettier-config');
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
    if (jsonObj.dependencies['@willbooster/wb']) {
      dependencies.push('@willbooster/wb');
    } else {
      devDependencies.push('@willbooster/wb');
    }
    for (const [key, value] of Object.entries(jsonObj.scripts)) {
      if (typeof value !== 'string') continue;
      jsonObj.scripts[key] = value.replaceAll(/wb\s+db/gu, 'wb prisma');
    }
  }

  const doesContainJsOrTs =
    config.doesContainJavaScript ||
    config.doesContainJavaScriptInPackages ||
    config.doesContainTypeScript ||
    config.doesContainTypeScriptInPackages;
  if (doesContainJsOrTs) {
    if (config.isBun) {
      devDependencies.push('@biomejs/biome', '@willbooster/biome-config');
      delete jsonObj.devDependencies.eslint;
      delete jsonObj.devDependencies.micromatch;
      delete jsonObj.devDependencies['typescript-eslint'];
    } else {
      devDependencies.push('eslint', 'micromatch');
    }
  }

  if (doesContainJsOrTs) {
    devDependencies.push(...getTsconfigBaseDependencies(config));
  }

  if (config.doesContainTypeScript || config.doesContainTypeScriptInPackages) {
    devDependencies.push('typescript');
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

  if (config.eslintBase) {
    if (config.eslintBase.includes('react')) {
      delete jsonObj.devDependencies['eslint-plugin-react'];
      delete jsonObj.devDependencies['eslint-plugin-react-hooks'];
    }
    devDependencies.push(...eslintDeps[config.eslintBase]);
  }

  if (config.isWillBoosterConfigs) {
    return {
      dependencies: dependencies.filter((dep) => !dep.includes('@willbooster/')),
      devDependencies: devDependencies.filter((dep) => !dep.includes('@willbooster/')),
      poetryDevDependencies,
    };
  }

  return { dependencies, devDependencies, poetryDevDependencies };
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
        jsonObj.scripts['lint-fix'] = (jsonObj.scripts['lint-fix'] ?? '') + EslintUtil.getLintFixSuffix(config);
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
        jsonObj.scripts.format = (jsonObj.scripts.format ?? '') + ` && yarn format-code`;
      }
    }

    if (config.doesContainPoetryLock) {
      if (jsonObj.scripts.postinstall === 'poetry install') {
        delete jsonObj.scripts.postinstall;
      }
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
        jsonObj.scripts['format-code'] =
          `poetry run isort --profile black ${dirNamesStr} && poetry run black ${dirNamesStr}`;
        if (jsonObj.scripts.lint) {
          jsonObj.scripts.lint = `poetry run flake8 ${dirNamesStr} && ${jsonObj.scripts.lint}`;
        } else {
          jsonObj.scripts.lint = `poetry run flake8 ${dirNamesStr}`;
          jsonObj.scripts['lint-fix'] = 'yarn lint';
        }
        jsonObj.scripts.format = (jsonObj.scripts.format ?? '') + ` && yarn format-code`;
        dependencyUpdates.poetryDevDependencies.push('black', 'isort', 'flake8');
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

  if (!jsonObj.dependencies.prettier) {
    // Because @types/prettier blocks prettier execution.
    delete jsonObj.devDependencies['@types/prettier'];
  }
}

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
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
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

  if (dependencyUpdates.poetryDevDependencies.length > 0) {
    spawnSync('poetry', ['add', '--group', 'dev', ...new Set(dependencyUpdates.poetryDevDependencies)], config.dirPath);
  }
}

function installNpmDependencies(
  config: PackageConfig,
  packageManager: 'bun' | 'yarn',
  dependencies: string[],
  dev: boolean
): void {
  if (dependencies.length === 0) return;

  const dependencySpecifiers = [...new Set(dependencies)].map((dependency) => getDependencySpecifier(dependency));
  if (config.isBun) {
    spawnSync(packageManager, ['add', ...(dev ? ['-D'] : []), '--exact', ...dependencySpecifiers], config.dirPath);
  } else {
    // Intentionally omit versions to update dependencies to the latest versions with Yarn.
    spawnSync(packageManager, ['add', ...(dev ? ['-D'] : []), ...dependencySpecifiers], config.dirPath);
  }
}

function addPackageJsonDependencies(
  packageJsonDependencies: Partial<Record<string, string>>,
  dependencies: string[]
): string[] {
  const dependenciesToInstall: string[] = [];
  for (const dependency of new Set(dependencies)) {
    if (shouldUpdateExistingManagedDependency(dependency, packageJsonDependencies[dependency])) {
      dependenciesToInstall.push(dependency);
    }
    if (packageJsonDependencies[dependency] && !getPinnedDependencySpecifier(dependency)) continue;
    packageJsonDependencies[dependency] = getPackageJsonDependencyVersion(dependency);
  }
  return dependenciesToInstall;
}

function getPackageJsonDependencyVersion(dependency: string): string {
  const dependencySpecifier = getDependencySpecifier(dependency);
  return dependencySpecifier.startsWith(`${dependency}@`) ? dependencySpecifier.slice(dependency.length + 1) : '*';
}

// TODO: remove the following migration code in future
async function removeDeprecatedStuff(
  jsonObj: SetRequired<PackageJson, 'scripts' | 'dependencies' | 'devDependencies'>,
  dirPath: string
): Promise<void> {
  if (jsonObj.author === 'WillBooster LLC') {
    jsonObj.author = 'WillBooster Inc.';
  }
  delete jsonObj.scripts['sort-package-json'];
  delete jsonObj.scripts['sort-all-package-json'];
  delete jsonObj.scripts['typecheck/warn'];
  delete jsonObj.scripts['typecheck:gen-code'];
  delete jsonObj.scripts['typecheck:codegen'];
  delete jsonObj.dependencies.tslib;
  delete jsonObj.devDependencies['@willbooster/eslint-config'];
  delete jsonObj.devDependencies['@willbooster/eslint-config-react'];
  delete jsonObj.devDependencies['@willbooster/renovate-config'];
  delete jsonObj.devDependencies['@willbooster/tsconfig'];
  delete jsonObj.devDependencies['eslint-import-resolver-node'];
  delete jsonObj.devDependencies['eslint-plugin-prettier'];
  delete jsonObj.devDependencies.lerna;
  // To install the latest pinst
  delete jsonObj.devDependencies.pinst;
  delete jsonObj.scripts['flutter-format'];
  delete jsonObj.scripts['format-flutter'];
  delete jsonObj.scripts['python-format'];
  delete jsonObj.scripts['format-python'];
  delete jsonObj.scripts.prettier;
  delete jsonObj.scripts['check-all'];
  await promisePool.run(() => fs.promises.rm(path.resolve(dirPath, 'lerna.json'), { force: true }));

  // Migrate from ESLint legacy configs to flat configs,
  delete jsonObj.devDependencies['@typescript-eslint/eslint-plugin'];
  delete jsonObj.devDependencies['@typescript-eslint/parser'];
  delete jsonObj.devDependencies['eslint-plugin-import'];
}

function getDependencySpecifier(dependency: string): string {
  return getPinnedDependencySpecifier(dependency) ?? dependency;
}

function shouldUpdateExistingManagedDependency(dependency: string, currentVersion: string | undefined): boolean {
  if (!currentVersion) return true;
  const pinnedSpecifier = getPinnedDependencySpecifier(dependency);
  if (pinnedSpecifier) {
    return currentVersion !== getPackageJsonDependencyVersion(dependency);
  }
  return dependency.startsWith('@willbooster/eslint-config-');
}

function addStartTestServerScriptIfNeeded(config: PackageConfig, jsonObj: PackageJson): void {
  if (!config.depending.playwrightTest || !config.depending.wb || jsonObj.scripts?.['start-test-server']) {
    return;
  }

  jsonObj.scripts ??= {};
  jsonObj.scripts['start-test-server'] = 'wb start --mode test';
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
      'check-for-ai': `bun run cleanup${hasTypecheck ? ' && bun run typecheck' : ''}`,
      cleanup: 'bun --bun wb lint --fix --format',
      format: `bun --bun wb lint --format`,
      lint: `bun --bun wb lint`,
      'lint-fix': 'bun --bun wb lint --fix',
      test: 'bun wb test',
      typecheck: 'bun --bun wb typecheck',
    };
    if (!hasTypecheck) {
      delete scripts.typecheck;
    }
    return scripts;
  } else {
    const hasTypecheck = config.doesContainTypeScript || config.doesContainTypeScriptInPackages;
    const oldTest = oldScripts.test;
    let scripts: Record<string, string> = {
      'check-all-for-ai': 'yarn check-for-ai && yarn test',
      'check-for-ai': `yarn format > /dev/null 2> /dev/null || true${
        hasTypecheck ? ' && yarn typecheck' : ''
      } && yarn lint-fix --quiet`,
      cleanup: 'yarn format && yarn lint-fix',
      format: `sort-package-json && yarn prettify`,
      lint: `eslint --color`,
      'lint-fix': 'yarn lint --fix',
      prettify: `prettier --cache --color --write "**/{.*/,}*.{${extensions.prettier.join(',')}}" "!**/test{-,/}fixtures/**"`,
      typecheck: 'tsc --noEmit',
    };
    if (config.doesContainSubPackageJsons) {
      scripts = merge(
        { ...scripts },
        {
          format: `sort-package-json && yarn prettify && yarn workspaces foreach --all --parallel --verbose run format`,
          lint: `yarn workspaces foreach --all --parallel --verbose run lint`,
          'lint-fix': 'yarn workspaces foreach --all --parallel --verbose run lint-fix',
          prettify: `prettier --cache --color --write "**/{.*/,}*.{${extensions.prettier.join(
            ','
          )}}" "!**/packages/**" "!**/test{-,/}fixtures/**"`,
          // CI=1 prevents vitest from enabling watch.
          // FORCE_COLOR=3 make wb enable color output.
          test: 'CI=1 FORCE_COLOR=3 yarn workspaces foreach --all --verbose run test',
          typecheck: 'yarn workspaces foreach --all --parallel --verbose run typecheck',
        }
      );
    } else if (config.depending.pyright) {
      scripts.typecheck = scripts.typecheck ? `${scripts.typecheck} && ` : '';
      scripts.typecheck += 'pyright';
    }
    if (oldTest?.includes('wb test')) {
      scripts.test = oldTest;
    }

    if (!hasTypecheck) {
      delete scripts.typecheck;
    } else if (config.depending.wb) {
      scripts.typecheck = 'wb typecheck';
    }
    return scripts;
  }
}

async function generatePrettierSuffix(dirPath: string): Promise<string> {
  const filePath = path.resolve(dirPath, '.prettierignore');
  const existingContent = await fs.promises.readFile(filePath, 'utf8');
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
