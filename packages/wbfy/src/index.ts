import fs from 'node:fs';
import path from 'node:path';

import { ignoreError, ignoreErrorAsync } from '@willbooster/shared-lib/src';
import { normalizeBunLockfile } from '@willbooster/shared-lib-node/src';
import semver from 'semver';
import yargs from 'yargs';

import { fixNextConfigJson } from './fixers/nextConfig.js';
import { fixChakraToaster } from './fixers/chakraToaster.js';
import { fixPlaywrightConfig } from './fixers/playwrightConfig.js';
import { fixTestDirectoriesUpdatingPackageJson } from './fixers/testDirectory.js';
import { fixTypeDefinitions } from './fixers/typeDefinition.js';
import { fixTypos } from './fixers/typos.js';
import { untrackCloudflareEnv } from './fixers/cloudflareEnv.js';
import { generateAgentInstructions } from './generators/agents.js';
import { generateBunfigToml, readBunGlobalStore, resolveBunGlobalStore } from './generators/bunfig.js';
import { generateDockerignore } from './generators/dockerignore.js';
import { generateEditorconfig } from './generators/editorconfig.js';
import { generateFnoxToml } from './generators/fnoxToml.js';
import { generateGeminiConfig } from './generators/geminiConfig.js';
import { removeGeminiSettings } from './generators/geminiSettings.js';
import { generateGitattributes, renormalizeTrackedTextFiles } from './generators/gitattributes.js';
import { generateGitignore } from './generators/gitignore.js';
import { ensureGlobalReleaseAgeGates } from './generators/globalReleaseAgeGate.js';
import { generateIdeaSettings } from './generators/idea.js';
import { generateLefthookUpdatingPackageJson } from './generators/lefthook.js';
import { generateLintstagedrc } from './generators/lintstagedrc.js';
import { generatePackageJson, getWorkspacePackageDirs } from './generators/packageJson.js';
import { generateOxfmtConfig } from './generators/oxfmtConfig.js';
import { generateOxlintConfig } from './generators/oxlintConfig.js';
import { generatePrettierignore } from './generators/prettierignore.js';
import { generatePyrightConfigJson } from './generators/pyrightConfig.js';
import { fixRailwayignore } from './generators/railwayignore.js';
import { generateReadme, readAppliedWbfyVersionLabel } from './generators/readme.js';
import { generateReleaserc } from './generators/releaserc.js';
import { generateRenovateJsonc } from './generators/renovateJsonc.js';
import { generateTsconfig } from './generators/tsconfig.js';
import { generateVscodeSettings } from './generators/vscodeSettings.js';
import { ensureWbEnvDefinitions } from './generators/wbEnv.js';
import { generateSelfContainedWorkflows } from './generators/selfContainedWorkflow.js';
import { generateWorkflows, isReusableWorkflowsRepo } from './generators/workflow.js';
import { generateMiseToml, minimumBunVersion } from './generators/miseToml.js';
import { generateRepositoryNpmrc } from './generators/npmrc.js';
import { setupLabels } from './github/label.js';
import { setupRepositoryRulesets } from './github/ruleset.js';
import { setupGitHubSettings } from './github/settings.js';
import { generateGitHubTemplates } from './github/template.js';
import { options } from './options.js';
import type { PackageConfig } from './packageConfig.js';
import { getPackageConfig, getWorkerTypesScriptError } from './packageConfig.js';
import { assertSafeDependencySources } from './utils/dependencySourcePolicy.js';
import { fsUtil } from './utils/fsUtil.js';
import { doesContainJsOrTs } from './utils/packageCapabilities.js';
import { promisePool } from './utils/promisePool.js';
import { spawnSync, spawnSyncAndReturnStatus, spawnSyncAndReturnStdout } from './utils/spawnUtil.js';
import { disposeTypeScriptApi } from './utils/typescriptApi.js';
import { getWbfyVersion, getWbfyVersionLabel } from './utils/version.js';
import { getWorkspaceSubDirPaths } from './utils/workspaceUtil.js';

/**
 * Applies only the global release-age gate, without touching any repository. Spelled out in full
 * rather than shortened (e.g. `gate`) because the default command takes positional paths: a short
 * name would swallow a directory that happens to share it.
 */
const applyReleaseAgeGateCommand = 'apply-release-age-gate';

async function main(): Promise<void> {
  const argv = await yargs(process.argv.slice(2))
    .command(
      applyReleaseAgeGateCommand,
      "Apply only the organization's minimum-release-age policy to this machine's global package-manager configs"
    )
    .command('$0 [paths..]', 'Make a given project follow the WillBooster standard', (yargs) => {
      yargs.positional('paths', {
        describe: 'project paths to be wbfied',
        array: true,
        type: 'string',
        default: ['.'],
      });
    })
    .options({
      force: {
        description: 'Apply wbfy even when the repository already records this wbfy version',
        type: 'boolean',
        default: false,
        alias: 'f',
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

  // Deliberately before the Bun check in willboosterifyPaths(): the gate must be appliable on a
  // machine whose Bun is missing or outdated, which is exactly a machine that still needs gating.
  if (argv._[0] === applyReleaseAgeGateCommand) {
    if (!ensureGlobalReleaseAgeGates()) process.exitCode = 1;
    return;
  }

  let hasInvalidPackageConfig = false;
  try {
    hasInvalidPackageConfig = await willboosterifyPaths(argv.paths as string[], argv.skipDeps, argv.force);
  } finally {
    // The TypeScript compiler server spawned for AST parsing keeps an open IPC
    // channel that would otherwise prevent the Node.js process from exiting.
    disposeTypeScriptApi();
  }
  if (hasInvalidPackageConfig) {
    process.exitCode = 1;
  }
}

async function willboosterifyPaths(paths: string[], skipDeps: boolean, force: boolean): Promise<boolean> {
  // Before anything else — even the Bun check below: the developer machine's global
  // package-manager configs must receive the org's minimum-release-age policy on EVERY run,
  // because they are what guards brand-new local projects that have no wbfy-generated repository
  // config yet, and that protection must not depend on a working Bun installation.
  ensureGlobalReleaseAgeGates();

  // wbfy manages repositories through Bun + mise and runs `bun add` / `bun install`;
  // proceeding without Bun cannot produce or validate the managed lockfile.
  // The version floor matters too: older Bun silently ignores the generated bunfig.toml options
  // (globalStore, publicHoistPattern) and would validate a different install layout than the one
  // repositories get once mise upgrades them. It stays unconditional even though the already-applied
  // check below can make a run a no-op: a missing or outdated Bun is a broken environment wbfy must
  // report, and hiding it whenever every path happens to be skipped would surface it only later.
  const bunVersion = spawnSyncAndReturnStdout('bun', ['--version'], '.');
  if (!semver.valid(bunVersion)) {
    console.error('wbfy requires Bun. Install Bun (e.g. via mise) and re-run.');
    return true;
  }
  if (semver.lt(bunVersion, minimumBunVersion)) {
    console.error(`wbfy requires Bun >= ${minimumBunVersion} (found ${bunVersion}). Upgrade Bun and re-run.`);
    return true;
  }

  // A `-dirty-local` label identifies an edited checkout, whose next build produces different files
  // under the same label, so such a run is never treated as already applied.
  const versionLabel = getWbfyVersionLabel();
  const skippableVersionLabel =
    !force && versionLabel && !versionLabel.endsWith('-dirty-local') ? versionLabel : undefined;

  let hasInvalidPackageConfig = false;
  for (const rootDirPath of paths) {
    // Confine every generated file to this repository (see fsUtil.generateFile). Set BEFORE any
    // fixer writes, and reset on every iteration so a multi-path run never keeps the previous root.
    fsUtil.setRootDirPath(fs.existsSync(rootDirPath) ? rootDirPath : undefined);

    // The badge records the build that generated the repository's configuration, so the same build
    // would only rewrite what is already there. Skipping is a deliberate trade: the parts of a run
    // that depend on state OUTSIDE the repository (GitHub settings, dependency updates, the fetched
    // .gitignore) do get skipped too, which is what --force is for.
    if (skippableVersionLabel && (await readAppliedWbfyVersionLabel(rootDirPath)) === skippableVersionLabel) {
      console.info(`Skip ${rootDirPath}: wbfy ${skippableVersionLabel} is already applied. Pass --force to re-apply.`);
      continue;
    }
    const packagesDirPath = path.join(rootDirPath, 'packages');
    const dirents = (await ignoreErrorAsync(() => fs.promises.readdir(packagesDirPath, { withFileTypes: true }))) ?? [];
    const packagesSubDirPaths = dirents
      .filter((d) => d.isDirectory())
      .map((d) => path.resolve(packagesDirPath, d.name));
    // Also cover workspaces declared outside packages/* (e.g. apps/*): they receive the same
    // managed configs (tsconfig.json, package.json conventions, …) as packages/* children.
    const rootPackageJson =
      ignoreError(
        () =>
          JSON.parse(fs.readFileSync(path.resolve(rootDirPath, 'package.json'), 'utf8')) as PackageConfig['packageJson']
      ) ?? {};
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

    // Refused writes on core managed files would leave the repository partially updated, so skip
    // it BEFORE any mutation when one of them is a symlink or resolves outside the repository.
    const managedFilePaths = [
      ...['.gitattributes', 'bunfig.toml', 'lefthook.yml', 'package.json', 'tsconfig.json'].map((name) =>
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

    const preflightErrors = [rootDirPath, ...subDirPaths].flatMap((dirPath) => {
      const packageJsonPath = path.resolve(dirPath, 'package.json');
      if (!fs.existsSync(packageJsonPath)) return [];
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageConfig['packageJson'];
        const error = getWorkerTypesScriptError({ packageJson });
        return error ? [`${dirPath}: ${error}`] : [];
      } catch {
        return [`${packageJsonPath} is invalid`];
      }
    });
    if (preflightErrors.length > 0) {
      console.error(`Skip ${rootDirPath}:\n${preflightErrors.join('\n')}`);
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
    // Every discovered workspace (including non-packages/* layouts such as apps/*) is a child
    // package; the packages/* heuristic inside getPackageConfig would misclassify apps/* as roots.
    const nullableSubPackageConfigs = await Promise.all(
      subDirPaths.map((subDirPath) => getPackageConfig(subDirPath, { isRoot: false }))
    );
    const invalidSubPackageDirPath = subDirPaths.find(
      (subDirPath, index) => !nullableSubPackageConfigs[index] && fs.existsSync(path.join(subDirPath, 'package.json'))
    );
    if (invalidSubPackageDirPath) {
      console.error(`Skip ${rootDirPath}: ${invalidSubPackageDirPath}/package.json is invalid.`);
      hasInvalidPackageConfig = true;
      continue;
    }
    const subPackageConfigs = nullableSubPackageConfigs.filter((config) => !!config);
    const allPackageConfigs = [rootConfig, ...subPackageConfigs];
    const abbreviationPromise = fixTypos(rootConfig);

    await generateRepositoryNpmrc(allPackageConfigs);

    if (options.isVerbose) {
      for (const config of allPackageConfigs) {
        console.info(config);
      }
    }
    assertSafeDependencySources(allPackageConfigs);
    // Managed repositories use Bun with mise (and optionally fnox).
    const previousBunGlobalStore = readBunGlobalStore(rootDirPath);
    // Root-level install layout must cover workspace apps too: Next.js commonly lives under
    // packages/* or apps/* while bunfig.toml exists only at the repository root.
    const useGlobalStore = resolveBunGlobalStore(allPackageConfigs, previousBunGlobalStore, skipDeps);
    await generateBunfigToml(rootConfig, useGlobalStore);
    await generateMiseToml(rootConfig, bunVersion);
    await generateFnoxToml(rootConfig);
    // Run after generateFnoxToml so its transactional recipient sync cannot restore a snapshot
    // over definitions inserted here.
    await ensureWbEnvDefinitions(rootConfig, allPackageConfigs);
    // promisePool.run resolves when a task STARTS, so the generated bunfig.toml is not
    // guaranteed to be on disk yet; the probe below must not validate a stale configuration.
    await promisePool.promiseAll();

    // The layout must be verified installable BEFORE any `bun add` mutates package.json files:
    // per-package installs tolerate failures (spawnSync discards their status), so a layout that
    // cannot install would silently drop every managed dependency update for the rest of the run.
    if (!skipDeps && !probeIsolatedBunInstall(rootDirPath, rootConfig, previousBunGlobalStore, useGlobalStore)) {
      // refreshBunLock below is the authority on whether the final install failed.
      console.warn(`bun install currently fails in ${rootDirPath} under the isolated linker.`);
    }

    const shouldRunWorkflows =
      !isReusableWorkflowsRepo(rootConfig.repository) &&
      (rootConfig.repository?.startsWith('github:WillBooster/') ||
        rootConfig.repository?.startsWith('github:WillBoosterLab/'));
    // Other owners cannot call the organization's reusable workflows (their secrets and runners
    // do not exist there), so any other GitHub-hosted Node.js repository gets self-contained
    // workflows instead — keyed on repository state, never on the owner's identity.
    // rootConfig.isRoot: a direct workspace-child invocation (`wbfy <repo>/packages/<app>`) keeps
    // isRoot false, and GitHub ignores workflow files nested under a package directory.
    const shouldRunSelfContainedWorkflows =
      !shouldRunWorkflows &&
      !isReusableWorkflowsRepo(rootConfig.repository) &&
      !!rootConfig.repository?.startsWith('github:') &&
      rootConfig.doesContainPackageJson &&
      rootConfig.isRoot;
    await Promise.all([
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
      ...(shouldRunSelfContainedWorkflows ? [generateSelfContainedWorkflows(rootConfig, allPackageConfigs)] : []),
      setupLabels(rootConfig),
      setupRepositoryRulesets(rootConfig),
      setupGitHubSettings(rootConfig),
      // Git hooks are repository-level state: when the CLI entry is a child workspace
      // (`wbfy <repo>/apps/<app>`), installing Lefthook there would delete the child's .husky,
      // write a child lefthook.yml, and unset the ENCLOSING repository's core.hooksPath.
      ...(rootConfig.isRoot ? [generateLefthookUpdatingPackageJson(rootConfig, allPackageConfigs)] : []),
      generateLintstagedrc(rootConfig),
    ]);
    await promisePool.promiseAll();
    // After the workflow generator (and its pooled writes) so the instruction files describe the
    // finalized workflow files instead of lagging one run behind.
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
      if (config.depending.chakra) {
        promises.push(fixChakraToaster(config));
      }
      await generateGitignore(config, rootConfig);
      await promisePool.promiseAll();
      if (!config.isRoot && !config.doesContainPackageJson) {
        continue;
      }
      await generatePrettierignore(config);
      await generatePackageJson(config, rootConfig, skipDeps);
      // Only after the barrier above: the pooled .gitignore write (which carries the managed
      // .env.cloudflare rule) completed there, and the fixer re-verifies the rule via
      // `git check-ignore` before untracking.
      if (config.isCloudflare || rootConfig.isCloudflare) {
        await untrackCloudflareEnv(config);
      }

      promises.push(generateLintstagedrc(config));
      if (config.doesContainVscodeSettingsJson && config.doesContainPackageJson) {
        promises.push(generateVscodeSettings(config));
      }
      if (config.doesContainTypeScript || config.doesContainTypeScriptInPackages) {
        promises.push(generateTsconfig(config));
      }
      if (doesContainJsOrTs(config)) {
        promises.push(generateOxfmtConfig(config));
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
    // Run after every pooled generator write so normalization cannot overwrite a concurrent
    // update, and before cleanup so formatter metadata caches observe the changed files.
    renormalizeTrackedTextFiles(rootDirPath);
    // Refresh lock files
    try {
      refreshBunLock(rootDirPath);
    } catch (error) {
      // A failed install must fail the CLI: exiting 0 with a stale or missing Bun lockfile would
      // hide a broken managed configuration.
      console.error('Failed to refresh the Bun lockfile:', (error as Error | undefined)?.message ?? error);
      hasInvalidPackageConfig = true;
    }
    try {
      // Bun writes bun.lock before lifecycle scripts, so a failed install can still leave Guard
      // URLs behind. Normalize both success and failure output without replacing the install error.
      const normalizedLockfilePath = normalizeBunLockfile(rootDirPath);
      if (normalizedLockfilePath) {
        console.info(`Removed Takumi Guard proxy URLs from ${normalizedLockfilePath} to keep it registry-agnostic.`);
      }
    } catch (error) {
      console.error('Failed to normalize the Bun lockfile:', (error as Error | undefined)?.message ?? error);
      hasInvalidPackageConfig = true;
    }
    spawnSync('bun', ['cleanup'], rootDirPath);
  }
  return hasInvalidPackageConfig;
}

/**
 * Probes `bun install` under the isolated linker. An incompatibility must be fixed in the
 * repository or in wbfy's managed lists, never by switching the linker. Returns false when the
 * install fails.
 */
function probeIsolatedBunInstall(
  rootDirPath: string,
  rootConfig: PackageConfig,
  previousGlobalStore: boolean | undefined,
  useGlobalStore: boolean
): boolean {
  // A layout switch must probe from a clean tree because Bun does not remove the previous layout's leftovers.
  if (previousGlobalStore !== useGlobalStore) {
    removeNodeModules(rootDirPath, rootConfig);
  }
  // Retry once so a transient failure (registry hiccup, flaky lifecycle script) does not
  // masquerade as a layout incompatibility.
  if (spawnSyncAndReturnStatus('bun', ['install'], rootDirPath, 1) === 0) return true;

  // Clean up the failed attempt so later installs do not run on a polluted tree.
  removeNodeModules(rootDirPath, rootConfig);
  return false;
}

function removeNodeModules(rootDirPath: string, rootConfig: PackageConfig): void {
  // Cover every declared workspace: leftovers can keep phantom dependencies resolvable.
  const nodeModulesPaths = [
    path.resolve(rootDirPath, 'node_modules'),
    ...[...getWorkspacePackageDirs(rootConfig).values()].map((workspaceDir) =>
      path.resolve(rootDirPath, workspaceDir, 'node_modules')
    ),
  ];
  // Never delete through a workspace symlink that escapes this repository.
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

function refreshBunLock(rootDirPath: string): void {
  // wbfy should update only the packages it explicitly manages through bun add.
  // Running bun update here refreshes unrelated application dependencies and
  // can change product behavior, so keep the existing lock and reconcile it.
  const status = spawnSyncAndReturnStatus('bun', ['install'], rootDirPath, 1);
  if (status === 0) return;
  throw new Error(`Failed to refresh Bun lockfile: bun install exited with status ${status}`);
}

await main();
