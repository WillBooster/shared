import fs from 'node:fs';
import path from 'node:path';

import { ignoreError, ignoreErrorAsync } from '@willbooster/shared-lib/src';
import semver from 'semver';
import yargs from 'yargs';

import { fixNextConfigJson } from './fixers/nextConfig.js';
import { fixPlaywrightConfig } from './fixers/playwrightConfig.js';
import { fixPrismaEnvFiles } from './fixers/prisma.js';
import { fixTestDirectoriesUpdatingPackageJson } from './fixers/testDirectory.js';
import { fixTypeDefinitions } from './fixers/typeDefinition.js';
import { fixTypos } from './fixers/typos.js';
import { fixWbDbCommand } from './fixers/wbDbCommand.js';
import { untrackCloudflareEnv } from './fixers/cloudflareEnv.js';
import { untrackWorkerTypes } from './fixers/workerTypes.js';
import { generateAgentInstructions } from './generators/agents.js';
import type { BunLinker } from './generators/bunfig.js';
import { generateBunfigToml, readBunLinker } from './generators/bunfig.js';
import { generateDockerignore } from './generators/dockerignore.js';
import { generateEditorconfig } from './generators/editorconfig.js';
import { generateFnoxToml } from './generators/fnoxToml.js';
import { generateGeminiConfig } from './generators/geminiConfig.js';
import { removeGeminiSettings } from './generators/geminiSettings.js';
import { generateGitattributes } from './generators/gitattributes.js';
import { generateGitignore } from './generators/gitignore.js';
import { generateIdeaSettings } from './generators/idea.js';
import { generateLefthookUpdatingPackageJson } from './generators/lefthook.js';
import { generateLintstagedrc } from './generators/lintstagedrc.js';
import { generatePackageJson, getWorkspacePackageDirs } from './generators/packageJson.js';
import { generateOxfmtConfig } from './generators/oxfmtConfig.js';
import { generateOxlintConfig } from './generators/oxlintConfig.js';
import { generatePrettierignore } from './generators/prettierignore.js';
import { generatePyrightConfigJson } from './generators/pyrightConfig.js';
import { fixRailwayignore } from './generators/railwayignore.js';
import { generateReadme } from './generators/readme.js';
import { generateReleaserc } from './generators/releaserc.js';
import { generateRenovateJsonc } from './generators/renovateJsonc.js';
import { generateTsconfig } from './generators/tsconfig.js';
import { fixVscodeExtensions, generateVscodeSettings } from './generators/vscodeSettings.js';
import { ensureWbEnvDefinitions } from './generators/wbEnv.js';
import { generateWorkflows, isReusableWorkflowsRepo } from './generators/workflow.js';
import { generateMiseToml, minimumBunVersion } from './generators/miseToml.js';
import {
  findUnmigratableYarnSettings,
  readYarnrcReleaseAgeSettings,
  removeYarnFiles,
  type YarnReleaseAgeSettings,
} from './generators/removeYarnFiles.js';
import { setupLabels } from './github/label.js';
import { setupRepositoryRulesets } from './github/ruleset.js';
import { setupSecrets } from './github/secret.js';
import { setupGitHubSettings } from './github/settings.js';
import { generateGitHubTemplates } from './github/template.js';
import { options } from './options.js';
import type { PackageConfig } from './packageConfig.js';
import { generatesWorkerTypes, getPackageConfig } from './packageConfig.js';
import { assertSafeDependencySources } from './utils/dependencySourcePolicy.js';
import { isExcludedRepo } from './utils/excludedRepo.js';
import { fsUtil } from './utils/fsUtil.js';
import { doesContainJsOrTs } from './utils/packageCapabilities.js';
import { promisePool } from './utils/promisePool.js';
import { spawnSync, spawnSyncAndReturnStatus, spawnSyncAndReturnStdout } from './utils/spawnUtil.js';
import { disposeTypeScriptApi } from './utils/typescriptApi.js';
import { getWbfyVersion } from './utils/version.js';
import { getWorkspaceSubDirPaths } from './utils/workspaceUtil.js';

async function main(): Promise<void> {
  const argv = await yargs(process.argv.slice(2))
    .command('$0 [paths..]', 'Make a given project follow the WillBooster standard', (yargs) => {
      yargs.positional('paths', {
        describe: 'project paths to be wbfied',
        array: true,
        type: 'string',
        default: ['.'],
      });
    })
    .options({
      env: {
        description: 'Upload environment variables as secrets to GitHub',
        type: 'boolean',
        default: false,
        alias: 'e',
      },
      skipDeps: {
        description:
          'Skip adding managed dependencies and the linker probe (the final `bun install` refreshing the lockfile still runs)',
        type: 'boolean',
        default: false,
        alias: 'd',
      },
      verbose: {
        description: 'Whether or not to enable verbose mode',
        type: 'boolean',
        default: false,
        alias: 'v',
      },
    })
    .version(getWbfyVersion())
    .strict().argv;
  options.isVerbose = argv.verbose;
  options.doesUploadEnvVars = argv.env;

  let hasInvalidPackageConfig = false;
  try {
    hasInvalidPackageConfig = await willboosterifyPaths(argv.paths as string[], argv.skipDeps);
  } finally {
    // The TypeScript compiler server spawned for AST parsing keeps an open IPC
    // channel that would otherwise prevent the Node.js process from exiting.
    disposeTypeScriptApi();
  }
  if (hasInvalidPackageConfig) {
    process.exitCode = 1;
  }
}

async function willboosterifyPaths(paths: string[], skipDeps: boolean): Promise<boolean> {
  // wbfy rewrites repositories to the Bun + mise toolchain and runs `bun add` / `bun install`;
  // proceeding without Bun would delete Yarn state and then fail to produce a Bun lockfile.
  // The version floor matters too: older Bun silently ignores the generated bunfig.toml options
  // (globalStore, publicHoistPattern) and would validate a different install layout than the one
  // repositories get once mise upgrades them.
  const bunVersion = spawnSyncAndReturnStdout('bun', ['--version'], '.');
  if (!semver.valid(bunVersion)) {
    console.error('wbfy requires Bun. Install Bun (e.g. via mise) and re-run.');
    return true;
  }
  if (semver.lt(bunVersion, minimumBunVersion)) {
    console.error(`wbfy requires Bun >= ${minimumBunVersion} (found ${bunVersion}). Upgrade Bun and re-run.`);
    return true;
  }

  let hasInvalidPackageConfig = false;
  for (const rootDirPath of paths) {
    // Confine every generated file to this repository (see fsUtil.generateFile). Set BEFORE any
    // fixer writes, and reset on every iteration so a multi-path run never keeps the previous root.
    fsUtil.setRootDirPath(fs.existsSync(rootDirPath) ? rootDirPath : undefined);
    const rootPackageJson =
      ignoreError(
        () =>
          JSON.parse(fs.readFileSync(path.resolve(rootDirPath, 'package.json'), 'utf8')) as PackageConfig['packageJson']
      ) ?? {};
    if (isExcludedRepo(rootDirPath, rootPackageJson)) {
      console.info(`Skip ${rootDirPath}: excluded from wbfy.`);
      continue;
    }
    // Read-only preflight before ANY fixer mutates the repository: Yarn configuration without an
    // automatic Bun translation must abort the whole migration for this path, not just the file
    // removal — otherwise wbfy would leave a half-migrated repository that neither tool can build.
    const unmigratableYarnSettings = findUnmigratableYarnSettings(rootDirPath);
    if (unmigratableYarnSettings) {
      console.error(
        `Skip ${rootDirPath}: ${unmigratableYarnSettings}. ` +
          'Migrate it to Bun manually (bunfig.toml install settings / patchedDependencies), then re-run wbfy, ' +
          "or add the repository to wbfy's excludedRepoNames when it is deliberately kept off the standard."
      );
      hasInvalidPackageConfig = true;
      continue;
    }

    const packagesDirPath = path.join(rootDirPath, 'packages');
    const dirents = (await ignoreErrorAsync(() => fs.promises.readdir(packagesDirPath, { withFileTypes: true }))) ?? [];
    const packagesSubDirPaths = dirents
      .filter((d) => d.isDirectory())
      .map((d) => path.resolve(packagesDirPath, d.name));
    // Also cover workspaces declared outside packages/* (e.g. apps/*): they receive the same
    // managed configs (tsconfig.json, package.json conventions, …) as packages/* children.
    const workspaceSubDirPaths = getWorkspaceSubDirPaths({
      dirPath: rootDirPath,
      packageJson: rootPackageJson,
      doesContainSubPackageJsons: packagesSubDirPaths.some((subDirPath) =>
        fs.existsSync(path.resolve(subDirPath, 'package.json'))
      ),
    });
    const subDirPaths = [...new Set([...packagesSubDirPaths, ...workspaceSubDirPaths])].filter(
      (subDirPath) => subDirPath !== path.resolve(rootDirPath)
    );

    // Refused writes on core managed files would leave the migration half-applied (e.g. Yarn state
    // removed but bunfig.toml unchanged, or a test directory renamed without its script), so skip
    // the repository BEFORE any mutation when one of them is a symlink or resolves outside it.
    const managedFilePaths = [
      ...['bunfig.toml', 'lefthook.yml', 'package.json', 'tsconfig.json'].map((name) =>
        path.resolve(rootDirPath, name)
      ),
      ...subDirPaths.flatMap((subDirPath) =>
        ['package.json', 'tsconfig.json'].map((name) => path.resolve(subDirPath, name))
      ),
    ];
    const writableResults = await Promise.all(
      managedFilePaths.map((filePath) => fsUtil.isConfinedWritablePath(filePath))
    );
    if (writableResults.includes(false)) {
      console.error(`Skip ${rootDirPath}: a managed config file is a symlink or resolves outside the repository.`);
      hasInvalidPackageConfig = true;
      continue;
    }

    await fixTestDirectoriesUpdatingPackageJson([rootDirPath, ...subDirPaths]);

    // Let getPackageConfig derive isRoot for the entry path: `wbfy <repo>/packages/<app>` is a
    // supported invocation whose target must keep its child classification, so forcing
    // `isRoot: true` here would apply root-only processing (lefthook install, root tsconfig,
    // AGENTS.md, …) to a subpackage.
    const rootConfig = await getPackageConfig(rootDirPath);
    if (options.isVerbose) {
      console.log('rootConfig:', rootConfig);
    }
    if (!rootConfig) {
      console.error(`there is no valid package.json in ${rootDirPath}`);
      hasInvalidPackageConfig = true;
      continue;
    }
    const abbreviationPromise = fixTypos(rootConfig);

    // Every discovered workspace (including non-packages/* layouts such as apps/*) is a child
    // package; the packages/* heuristic inside getPackageConfig would misclassify apps/* as roots.
    const nullableSubPackageConfigs = await Promise.all(
      subDirPaths.map((subDirPath) => getPackageConfig(subDirPath, { isRoot: false }))
    );
    const subPackageConfigs = nullableSubPackageConfigs.filter((config) => !!config);
    const allPackageConfigs = [rootConfig, ...subPackageConfigs];

    if (options.isVerbose) {
      for (const config of allPackageConfigs) {
        console.info(config);
      }
    }
    assertSafeDependencySources(allPackageConfigs);

    // Managed repositories use Bun with mise (and optionally fnox); Yarn artifacts are removed.
    // Deciding the linker requires running installs, so --skip-deps keeps the previous linker
    // and skips the probe (and its node_modules cleanup) entirely.
    const previousBunLinker = readBunLinker(rootDirPath);
    // Read BEFORE removeYarnFiles deletes .yarnrc.yml: the generated bunfig.toml keeps the
    // repository's release-age-gate behavior (npmMinimalAgeGate / npmPreapprovedPackages).
    const yarnReleaseAgeSettings = readYarnrcReleaseAgeSettings(rootDirPath);
    await removeYarnFiles(rootConfig);
    await generateBunfigToml(
      rootConfig,
      skipDeps ? (previousBunLinker ?? 'isolated') : 'isolated',
      yarnReleaseAgeSettings
    );
    await generateMiseToml(rootConfig, bunVersion);
    // Must finish before setupSecrets below: it rewrites the age recipients in fnox.toml and
    // re-encrypts the secrets that FNOX_AGE_KEY (uploaded by setupSecrets) must be able to decrypt.
    await generateFnoxToml(rootConfig);
    // After generateFnoxToml so the insertion can never race the transactional recipient
    // migration (which snapshots and may restore every fnox.toml).
    await ensureWbEnvDefinitions(rootConfig, allPackageConfigs);
    // promisePool.run resolves when a task STARTS, so the generated bunfig.toml is not
    // guaranteed to be on disk yet; the probe below must not validate a stale configuration.
    await promisePool.promiseAll();

    // The linker must be decided BEFORE any `bun add` mutates package.json files: per-package
    // installs tolerate failures (spawnSync discards their status), so a layout that cannot
    // install would silently drop every managed dependency update for the rest of the run.
    if (
      !skipDeps &&
      !(await ensureInstallableBunLinker(rootDirPath, rootConfig, previousBunLinker, yarnReleaseAgeSettings))
    ) {
      // Do not fail the run here: the probe observes the pre-migration lifecycle scripts (e.g.
      // still-Yarn-based postinstall commands that generatePackageJson converts later), so both
      // layouts can fail spuriously. refreshBunLock runs after the conversion and is the single
      // authority on whether the final install — and therefore the run — failed.
      console.warn(`bun install currently fails in ${rootDirPath} under both the isolated and hoisted linkers.`);
    }

    const shouldRunWorkflows =
      !isReusableWorkflowsRepo(rootConfig.repository) &&
      (rootConfig.repository?.startsWith('github:WillBooster/') ||
        rootConfig.repository?.startsWith('github:WillBoosterLab/'));
    await Promise.all([
      fixPrismaEnvFiles(rootConfig),
      abbreviationPromise.then(() => generateReadme(rootConfig)),
      generateDockerignore(rootConfig),
      generateEditorconfig(rootConfig),
      generateGeminiConfig(rootConfig, allPackageConfigs),
      removeGeminiSettings(rootConfig),
      generateGitattributes(rootConfig),
      generateGitHubTemplates(rootConfig),
      generateIdeaSettings(rootConfig),
      fixRailwayignore(rootConfig),
      generateRenovateJsonc(rootConfig),
      generateReleaserc(rootConfig),
      ...(shouldRunWorkflows ? [generateWorkflows(rootConfig)] : []),
      setupLabels(rootConfig),
      setupRepositoryRulesets(rootConfig),
      setupSecrets(rootConfig),
      setupGitHubSettings(rootConfig),
      // Git hooks are repository-level state: when the CLI entry is a child workspace
      // (`wbfy <repo>/apps/<app>`), installing Lefthook there would delete the child's .husky,
      // write a child lefthook.yml, and unset the ENCLOSING repository's core.hooksPath.
      ...(rootConfig.isRoot ? [generateLefthookUpdatingPackageJson(rootConfig, allPackageConfigs)] : []),
      generateLintstagedrc(rootConfig),
    ]);
    await promisePool.promiseAll();
    // After the workflow generator (and its pooled writes) so the instruction files see the
    // deploy workflows a first run scaffolds instead of lagging one run behind.
    await generateAgentInstructions(rootConfig, allPackageConfigs);
    await promisePool.promiseAll();

    const promises: Promise<void>[] = [];
    for (const config of allPackageConfigs) {
      if (config.doesContainTypeScript || config.doesContainTypeScriptInPackages) {
        promises.push(fixTypeDefinitions(config, config.isRoot ? allPackageConfigs : [config]));
      }
      if (config.depending.playwrightTest) {
        promises.push(fixPlaywrightConfig(config));
      }
      if (config.depending.next) {
        promises.push(fixNextConfigJson(config));
      }
      await generateGitignore(config, rootConfig);
      await promisePool.promiseAll();
      if (!config.isRoot && !config.doesContainPackageJson) {
        continue;
      }
      await generatePrettierignore(config);
      await generatePackageJson(config, rootConfig, skipDeps);
      // Only after both the barrier above — where the pooled .gitignore write actually completes — and the
      // package.json generation: untracking a file that did not get ignored (e.g. the gitignore.io fetch failed) or
      // whose postinstall does not actually regenerate it (generatePackageJson swallows its own exceptions, so a
      // partial run is possible) would delete the declaration with nothing recreating it on fresh checkouts.
      if (generatesWorkerTypes(config)) {
        await untrackWorkerTypes(config);
      }
      // Same barrier reasoning as untrackWorkerTypes: the pooled .gitignore write (which carries
      // the managed .env.cloudflare rule) completed above, and the fixer re-verifies the rule via
      // `git check-ignore` before untracking.
      if (config.isCloudflare || rootConfig.isCloudflare) {
        await untrackCloudflareEnv(config);
      }

      promises.push(generateLintstagedrc(config));
      if (config.doesContainVscodeSettingsJson && config.doesContainPackageJson) {
        promises.push(generateVscodeSettings(config));
      }
      if (config.doesContainPackageJson) {
        promises.push(fixVscodeExtensions(config));
      }
      if (config.doesContainTypeScript || config.doesContainTypeScriptInPackages) {
        promises.push(generateTsconfig(config));
      }
      if (doesContainJsOrTs(config)) {
        promises.push(generateOxfmtConfig(config, rootConfig));
        promises.push(generateOxlintConfig(config, rootConfig));
      } else if (!config.isRoot && config.doesContainPackageJson && doesContainJsOrTs(rootConfig)) {
        // Monorepo verification can invoke oxlint from every workspace. Give
        // non-code packages a local config so oxlint does not climb to the
        // root config and reject root-only type-aware options from a package cwd.
        promises.push(generateOxlintConfig(config, rootConfig));
      }
      if (config.depending.pyright) {
        promises.push(generatePyrightConfigJson(config));
      }
    }
    await Promise.all(promises);
    await promisePool.promiseAll();
    await fixWbDbCommand(rootConfig, allPackageConfigs);

    // Refresh lock files
    try {
      await refreshBunLock(rootDirPath, rootConfig, yarnReleaseAgeSettings);
      // Now that bun.lock exists (migrated from yarn.lock when there was none), the Yarn lockfile
      // that removeYarnFiles intentionally preserved for the migration can be removed.
      fs.rmSync(path.resolve(rootDirPath, 'yarn.lock'), { force: true });
    } catch (error) {
      // A failed install must fail the CLI: exiting 0 with a stale or missing Bun lockfile would
      // hide a broken migration.
      console.error('Failed to refresh the Bun lockfile:', (error as Error | undefined)?.message ?? error);
      hasInvalidPackageConfig = true;
    }
    spawnSync('bun', ['cleanup'], rootDirPath);
  }
  return hasInvalidPackageConfig;
}

/**
 * Probes `bun install` under the isolated linker (the default bunfig.toml wbfy generates) and
 * falls back to the hoisted linker when the isolated layout cannot install — it breaks projects
 * relying on hoisted (phantom) dependencies or on install scripts incompatible with the layout.
 * Returns false when neither linker can install. The probe reruns on every wbfy run, so a
 * repository automatically moves back to the isolated linker once its incompatibility is fixed.
 */
async function ensureInstallableBunLinker(
  rootDirPath: string,
  rootConfig: PackageConfig,
  previousLinker: BunLinker | undefined,
  yarnReleaseAgeSettings: YarnReleaseAgeSettings
): Promise<boolean> {
  // A layout switch must probe from a clean tree: `bun install` does not remove packages the
  // previous layout left behind, so e.g. still-hoisted phantom dependencies can make the isolated
  // probe succeed although a fresh checkout could not install.
  if (previousLinker !== 'isolated') {
    removeNodeModules(rootDirPath, rootConfig);
  }
  // Retry once so a transient failure (registry hiccup, flaky lifecycle script) does not
  // masquerade as a layout incompatibility.
  if (spawnSyncAndReturnStatus('bun', ['install'], rootDirPath, 1) === 0) return true;

  console.warn('bun install failed with the isolated linker; falling back to the hoisted linker.');
  await generateBunfigToml(rootConfig, 'hoisted', yarnReleaseAgeSettings);
  await promisePool.promiseAll();
  // The failed isolated attempt may have left a partial isolated tree behind.
  removeNodeModules(rootDirPath, rootConfig);
  // Retry here too: a transient failure would otherwise discard the correct hoisted answer and
  // restore the isolated configuration this function just proved cannot install.
  if (spawnSyncAndReturnStatus('bun', ['install'], rootDirPath, 1) === 0) return true;

  // Both layouts failed, so the failure is not linker-specific; keep the default isolated
  // configuration instead of persisting a downgrade that the failed install never justified.
  // Clean up the failed hoisted attempt too, so later installs do not run on a polluted tree.
  await generateBunfigToml(rootConfig, 'isolated', yarnReleaseAgeSettings);
  await promisePool.promiseAll();
  removeNodeModules(rootDirPath, rootConfig);
  return false;
}

function removeNodeModules(rootDirPath: string, rootConfig: PackageConfig): void {
  // Cover every declared workspace (e.g. apps/*), not just packages/*: a leftover workspace tree
  // can keep phantom dependencies resolvable and defeat the clean-tree probe.
  const nodeModulesPaths = [
    path.resolve(rootDirPath, 'node_modules'),
    ...[...getWorkspacePackageDirs(rootConfig).values()].map((workspaceDir) =>
      path.resolve(rootDirPath, workspaceDir, 'node_modules')
    ),
  ];
  // Never delete through a symlink escaping the repository: a workspace directory (or one of its
  // ancestors) linked to another project must not cost that project its node_modules.
  const realRootDirPath = fs.realpathSync(rootDirPath);
  for (const nodeModulesPath of nodeModulesPaths) {
    const realParentDirPath = ignoreError(() => fs.realpathSync(path.dirname(nodeModulesPath)));
    if (
      !realParentDirPath ||
      (realParentDirPath !== realRootDirPath && !realParentDirPath.startsWith(realRootDirPath + path.sep))
    ) {
      continue;
    }
    fs.rmSync(nodeModulesPath, { recursive: true, force: true });
  }
}

async function refreshBunLock(
  rootDirPath: string,
  rootConfig: PackageConfig,
  yarnReleaseAgeSettings: YarnReleaseAgeSettings
): Promise<void> {
  // wbfy should update only the packages it explicitly manages through bun add.
  // Running bun update here refreshes unrelated application dependencies and
  // can change product behavior, so keep the existing lock and reconcile it.
  let status = spawnSyncAndReturnStatus('bun', ['install'], rootDirPath, 1);
  if (status === 0) return;

  // The pre-conversion probe can be inconclusive (legacy lifecycle scripts fail under both
  // linkers), so the converted repository gets one more chance on the hoisted linker before the
  // run fails — e.g. a converted script may exercise a phantom dependency only hoisting provides.
  if (readBunLinker(rootDirPath) === 'isolated') {
    console.warn('bun install failed with the isolated linker after migration; retrying with the hoisted linker.');
    await generateBunfigToml(rootConfig, 'hoisted', yarnReleaseAgeSettings);
    await promisePool.promiseAll();
    removeNodeModules(rootDirPath, rootConfig);
    status = spawnSyncAndReturnStatus('bun', ['install'], rootDirPath, 1);
    if (status === 0) return;
    // Both layouts failed after conversion; restore the default isolated configuration and clean
    // up the failed hoisted attempt so the next run does not probe on a polluted tree.
    await generateBunfigToml(rootConfig, 'isolated', yarnReleaseAgeSettings);
    await promisePool.promiseAll();
    removeNodeModules(rootDirPath, rootConfig);
  }
  throw new Error(`Failed to refresh Bun lockfile: bun install exited with status ${status}`);
}

await main();
