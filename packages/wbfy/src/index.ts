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
import { generateAgentInstructions } from './generators/agents.js';
import { generateBunfigToml } from './generators/bunfig.js';
import { generateDockerignore } from './generators/dockerignore.js';
import { generateEditorconfig } from './generators/editorconfig.js';
import { generateGeminiConfig } from './generators/geminiConfig.js';
import { removeGeminiSettings } from './generators/geminiSettings.js';
import { generateGitattributes } from './generators/gitattributes.js';
import { generateGitignore } from './generators/gitignore.js';
import { generateIdeaSettings } from './generators/idea.js';
import { generateLefthookUpdatingPackageJson } from './generators/lefthook.js';
import { generateLintstagedrc } from './generators/lintstagedrc.js';
import { formatPackageJsonWithProjectFormatter, generatePackageJson } from './generators/packageJson.js';
import { generateOxfmtConfig } from './generators/oxfmtConfig.js';
import { generateOxlintConfig } from './generators/oxlintConfig.js';
import { generatePrettierignore } from './generators/prettierignore.js';
import { generatePyrightConfigJson } from './generators/pyrightConfig.js';
import { generateReadme } from './generators/readme.js';
import { generateReleaserc } from './generators/releaserc.js';
import { generateRenovateJson } from './generators/renovateJson.js';
import { installAgentSkills } from './generators/skills.js';
import { generateTsconfig } from './generators/tsconfig.js';
import { generateVscodeSettings } from './generators/vscodeSettings.js';
import { generateWorkflows, isReusableWorkflowsRepo } from './generators/workflow.js';
import { generateYarnrcYml } from './generators/yarnrc.js';
import { setupLabels } from './github/label.js';
import { setupSecrets } from './github/secret.js';
import { setupGitHubSettings } from './github/settings.js';
import { generateGitHubTemplates } from './github/template.js';
import { logger } from './logger.js';
import { options } from './options.js';
import { getPackageConfig } from './packageConfig.js';
import type { PackageConfig } from './packageConfig.js';
import { doesContainJsOrTs } from './utils/packageCapabilities.js';
import { promisePool } from './utils/promisePool.js';
import { spawnSync, spawnSyncAndReturnStatus } from './utils/spawnUtil.js';

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
  for (const rootDirPath of argv.paths as string[]) {
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

    const nullableSubPackageConfigs = await Promise.all(
      subDirPaths.map((subDirPath) => getPackageConfig(subDirPath, rootConfig))
    );
    const subPackageConfigs = nullableSubPackageConfigs.filter((config) => !!config);
    const allPackageConfigs = [rootConfig, ...subPackageConfigs];

    if (options.isVerbose) {
      for (const config of allPackageConfigs) {
        console.info(config);
      }
    }

    // Install yarn berry
    await generateYarnrcYml(rootConfig);
    if (rootConfig.isBun) {
      await generateBunfigToml(rootConfig);
    }

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
      generateRenovateJson(rootConfig),
      generateReleaserc(rootConfig),
      ...(shouldRunWorkflows ? [generateWorkflows(rootConfig)] : []),
      setupLabels(rootConfig),
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
      await generatePackageJson(config, rootConfig, argv.skipDeps);

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
      }
      if (config.depending.pyright) {
        promises.push(generatePyrightConfigJson(config));
      }
    }
    await Promise.all(promises);
    await promisePool.promiseAll();

    const packageManager = rootConfig.isBun ? 'bun' : 'yarn';
    // Refresh lock files
    if (rootConfig.isBun) {
      await logger.functionIgnoringException('refreshBunLock', async () => {
        await Promise.resolve();
        refreshBunLock(rootDirPath);
      });
    } else {
      spawnSync(packageManager, ['install', '--no-immutable'], rootDirPath);
    }
    spawnSync(packageManager, ['cleanup'], rootDirPath);
    await formatPackageJsonsWithProjectFormatter(allPackageConfigs, packageManager);

    await installAgentSkills(rootConfig);
  }
  if (hasInvalidPackageConfig) {
    process.exitCode = 1;
  }
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

async function formatPackageJsonsWithProjectFormatter(
  configs: PackageConfig[],
  packageManager: 'bun' | 'yarn'
): Promise<void> {
  // Some target repos sort package.json differently between the library API and
  // the CLI entry point of the same formatter version. Run the target repo's
  // CLI one final time after all generators and cleanup steps so the finished
  // tree already matches the autofix workflow's package.json order.
  for (const config of configs) {
    if (!config.isRoot && !config.doesContainPackageJson) continue;
    await formatPackageJsonWithProjectFormatter(config, packageManager, path.resolve(config.dirPath, 'package.json'));
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
