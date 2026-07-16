import fs from 'node:fs';
import path from 'node:path';

import { ignoreErrorAsync } from '@willbooster/shared-lib/src';
import yargs from 'yargs';

import { fixNextConfigJson } from './fixers/nextConfig.js';
import { fixPlaywrightConfig } from './fixers/playwrightConfig.js';
import { fixPrismaEnvFiles } from './fixers/prisma.js';
import { fixTestDirectoriesUpdatingPackageJson } from './fixers/testDirectory.js';
import { fixTypeDefinitions } from './fixers/typeDefinition.js';
import { fixTypos } from './fixers/typos.js';
import { fixWbDbCommand } from './fixers/wbDbCommand.js';
import { untrackWorkerTypes } from './fixers/workerTypes.js';
import { generateAgentInstructions } from './generators/agents.js';
import { generateBunfigToml } from './generators/bunfig.js';
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
import { generatePackageJson } from './generators/packageJson.js';
import { generateOxfmtConfig } from './generators/oxfmtConfig.js';
import { generateOxlintConfig } from './generators/oxlintConfig.js';
import { generatePrettierignore } from './generators/prettierignore.js';
import { generatePyrightConfigJson } from './generators/pyrightConfig.js';
import { fixRailwayignore } from './generators/railwayignore.js';
import { generateReadme } from './generators/readme.js';
import { generateReleaserc } from './generators/releaserc.js';
import { generateRenovateJson } from './generators/renovateJson.js';
import { installAgentSkills } from './generators/skills.js';
import { generateTsconfig } from './generators/tsconfig.js';
import { generateVscodeSettings } from './generators/vscodeSettings.js';
import { generateWorkflows, isReusableWorkflowsRepo } from './generators/workflow.js';
import { generateMiseToml } from './generators/miseToml.js';
import { findUnmigratableYarnSettings, removeYarnFiles } from './generators/removeYarnFiles.js';
import { setupLabels } from './github/label.js';
import { setupRepositoryRulesets } from './github/ruleset.js';
import { setupSecrets } from './github/secret.js';
import { setupGitHubSettings } from './github/settings.js';
import { generateGitHubTemplates } from './github/template.js';
import { options } from './options.js';
import { generatesWorkerTypes, getPackageConfig } from './packageConfig.js';
import { assertSafeDependencySources } from './utils/dependencySourcePolicy.js';
import { doesContainJsOrTs } from './utils/packageCapabilities.js';
import { promisePool } from './utils/promisePool.js';
import { spawnSync, spawnSyncAndReturnStatus } from './utils/spawnUtil.js';
import { disposeTypeScriptApi } from './utils/typescriptApi.js';

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
        description: 'Skip dependency installation',
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
    .version(getVersion())
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
  if (spawnSyncAndReturnStatus('bun', ['--version'], '.') !== 0) {
    console.error('wbfy requires Bun. Install Bun (e.g. via mise) and re-run.');
    return true;
  }

  let hasInvalidPackageConfig = false;
  for (const rootDirPath of paths) {
    // Read-only preflight before ANY fixer mutates the repository: Yarn configuration without an
    // automatic Bun translation must abort the whole migration for this path, not just the file
    // removal — otherwise wbfy would leave a half-migrated repository that neither tool can build.
    const unmigratableYarnSettings = findUnmigratableYarnSettings(rootDirPath);
    if (unmigratableYarnSettings) {
      console.error(
        `Skip ${rootDirPath}: ${unmigratableYarnSettings}. ` +
          'Migrate it to Bun manually (bunfig.toml install settings / patchedDependencies), then re-run wbfy.'
      );
      hasInvalidPackageConfig = true;
      continue;
    }

    const packagesDirPath = path.join(rootDirPath, 'packages');
    const dirents = (await ignoreErrorAsync(() => fs.promises.readdir(packagesDirPath, { withFileTypes: true }))) ?? [];
    const subDirPaths = dirents.filter((d) => d.isDirectory()).map((d) => path.join(packagesDirPath, d.name));

    await fixTestDirectoriesUpdatingPackageJson([rootDirPath, ...subDirPaths]);

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

    const nullableSubPackageConfigs = await Promise.all(subDirPaths.map((subDirPath) => getPackageConfig(subDirPath)));
    const subPackageConfigs = nullableSubPackageConfigs.filter((config) => !!config);
    const allPackageConfigs = [rootConfig, ...subPackageConfigs];

    if (options.isVerbose) {
      for (const config of allPackageConfigs) {
        console.info(config);
      }
    }
    assertSafeDependencySources(allPackageConfigs);

    // Managed repositories use Bun with mise (and optionally fnox); Yarn artifacts are removed.
    await removeYarnFiles(rootConfig);
    await generateBunfigToml(rootConfig);
    await generateMiseToml(rootConfig);
    // Must finish before setupSecrets below: it rewrites the age recipients in fnox.toml and
    // re-encrypts the secrets that FNOX_AGE_KEY (uploaded by setupSecrets) must be able to decrypt.
    await generateFnoxToml(rootConfig, allPackageConfigs);

    const shouldRunWorkflows =
      !isReusableWorkflowsRepo(rootConfig.repository) &&
      (rootConfig.repository?.startsWith('github:WillBooster/') ||
        rootConfig.repository?.startsWith('github:WillBoosterLab/'));
    await Promise.all([
      fixPrismaEnvFiles(rootConfig),
      abbreviationPromise.then(() => generateReadme(rootConfig)),
      generateAgentInstructions(rootConfig, allPackageConfigs),
      generateDockerignore(rootConfig),
      generateEditorconfig(rootConfig),
      generateGeminiConfig(rootConfig, allPackageConfigs),
      removeGeminiSettings(rootConfig),
      generateGitattributes(rootConfig),
      generateGitHubTemplates(rootConfig),
      generateIdeaSettings(rootConfig),
      fixRailwayignore(rootConfig),
      generateRenovateJson(rootConfig),
      generateReleaserc(rootConfig),
      ...(shouldRunWorkflows ? [generateWorkflows(rootConfig)] : []),
      setupLabels(rootConfig),
      setupRepositoryRulesets(rootConfig),
      setupSecrets(rootConfig),
      setupGitHubSettings(rootConfig),
      generateLefthookUpdatingPackageJson(rootConfig),
      generateLintstagedrc(rootConfig),
    ]);
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
    await fixWbDbCommand(rootConfig, allPackageConfigs);

    // Refresh lock files
    try {
      refreshBunLock(rootDirPath);
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

    await installAgentSkills(rootConfig);
  }
  return hasInvalidPackageConfig;
}

function refreshBunLock(rootDirPath: string): void {
  // wbfy should update only the packages it explicitly manages through bun add.
  // Running bun update here refreshes unrelated application dependencies and
  // can change product behavior, so keep the existing lock and reconcile it.
  const status = spawnSyncAndReturnStatus('bun', ['install'], rootDirPath);
  if (status !== 0) {
    throw new Error(`Failed to refresh Bun lockfile: bun install exited with status ${status}`);
  }
}

function getVersion(): string {
  let packageJsonDir = path.dirname(new URL(import.meta.url).pathname);
  while (!fs.existsSync(path.join(packageJsonDir, 'package.json'))) {
    packageJsonDir = path.dirname(packageJsonDir);
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageJsonDir, 'package.json'), 'utf8')) as {
    version: string;
  };
  return packageJson.version;
}

await main();
