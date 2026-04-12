import fs from 'node:fs';
import path from 'node:path';

import { ignoreErrorAsync } from '@willbooster/shared-lib/src';
import yargs from 'yargs';

import { fixDockerfile } from './fixers/dockerfile.js';
import { fixNextConfigJson } from './fixers/nextConfig.js';
import { fixPlaywrightConfig } from './fixers/playwrightConfig.js';
import { fixPrismaEnvFiles } from './fixers/prisma.js';
import { fixTestDirectoriesUpdatingPackageJson } from './fixers/testDirectory.js';
import { fixTypeDefinitions } from './fixers/typeDefinition.js';
import { fixTypos } from './fixers/typos.js';
import { generateAgentInstructions } from './generators/agents.js';
import { generateBiomeJsonc } from './generators/biome.js';
import { generateBunfigToml } from './generators/bunfig.js';
import { generateDockerignore } from './generators/dockerignore.js';
import { generateEditorconfig } from './generators/editorconfig.js';
import { generateEslintrc } from './generators/eslintConfig.js';
import { generateGeminiConfig } from './generators/geminiConfig.js';
import { removeGeminiSettings } from './generators/geminiSettings.js';
import { generateGitattributes } from './generators/gitattributes.js';
import { generateGitignore } from './generators/gitignore.js';
import { generateIdeaSettings } from './generators/idea.js';
import { generateLefthookUpdatingPackageJson } from './generators/lefthook.js';
import { generateLintstagedrc } from './generators/lintstagedrc.js';
import { generatePackageJson } from './generators/packageJson.js';
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
import { options } from './options.js';
import { getPackageConfig } from './packageConfig.js';
import { promisePool } from './utils/promisePool.js';
import { spawnSync, spawnSyncAndReturnStatus } from './utils/spawnUtil.js';
import { shouldSkipWillboosterConfigsEslintPackage } from './utils/willboosterConfigsUtil.js';

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

  for (const rootDirPath of argv.paths as string[]) {
    const packagesDirPath = path.join(rootDirPath, 'packages');
    const dirents = (await ignoreErrorAsync(() => fs.promises.readdir(packagesDirPath, { withFileTypes: true }))) ?? [];
    const subDirPaths = dirents.filter((d) => d.isDirectory()).map((d) => path.join(packagesDirPath, d.name));

    await fixTestDirectoriesUpdatingPackageJson([rootDirPath, ...subDirPaths]);

    const rootConfig = await getPackageConfig(rootDirPath);
    console.log('rootConfig:', rootConfig);
    if (!rootConfig) {
      console.error(`there is no valid package.json in ${rootDirPath}`);
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
      fixDockerfile(rootConfig),
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
      if (shouldSkipWillboosterConfigsEslintPackage(config)) {
        continue;
      }
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
      if (
        config.doesContainJavaScript ||
        config.doesContainJavaScriptInPackages ||
        config.doesContainTypeScript ||
        config.doesContainTypeScriptInPackages
      ) {
        if (rootConfig.isBun) {
          promises.push(generateBiomeJsonc(config));
        }
        if (!rootConfig.isWillBoosterConfigs) {
          promises.push(generateEslintrc(config));
        }
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
      refreshBunLock(rootDirPath);
    } else {
      fs.rmSync(path.join(rootDirPath, 'yarn.lock'), { force: true });
      spawnSync(packageManager, ['install', '--no-immutable'], rootDirPath);
    }
    spawnSync(packageManager, ['cleanup'], rootDirPath);
    // 'yarn install' should be after `yarn cleanup` because yarn berry generates yarn.lock
    // corresponding to the contents of dependant sub-package in monorepo
    if (!rootConfig.isBun) {
      spawnSync(packageManager, ['install', '--no-immutable'], rootDirPath);
    }

    await installAgentSkills(rootConfig);
  }
}

function refreshBunLock(rootDirPath: string): void {
  const lockFilePath = path.join(rootDirPath, 'bun.lock');
  const backupLockFilePath = path.join(rootDirPath, '.bun.lock.wbfy-backup');
  fs.rmSync(backupLockFilePath, { force: true });
  if (fs.existsSync(lockFilePath)) {
    // Regenerate from scratch, but keep the previous lockfile so a registry or
    // resolver failure cannot leave the repository without a lockfile.
    fs.copyFileSync(lockFilePath, backupLockFilePath);
    fs.rmSync(lockFilePath, { force: true });
  }

  const status = spawnSyncAndReturnStatus('bun', ['update'], rootDirPath);
  if (status === 0 && fs.existsSync(lockFilePath)) {
    fs.rmSync(backupLockFilePath, { force: true });
    return;
  }

  if (fs.existsSync(backupLockFilePath)) {
    fs.copyFileSync(backupLockFilePath, lockFilePath);
    fs.rmSync(backupLockFilePath, { force: true });
  }
  throw new Error(`Failed to regenerate ${lockFilePath}`);
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
