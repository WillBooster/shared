import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects } from '../project.js';
import { packageManager } from '../utils/runtime.js';

import { prepareForRunningCommand } from './commandUtils.js';

const runtimeDevDependencies = ['@willbooster/wb', 'build-ts'];

const builder = {
  outside: {
    description: 'Whether the optimization is executed outside a docker container or not',
    type: 'boolean',
    alias: 'o',
  },
} as const;

export const optimizeForDockerBuildCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'optimizeForDockerBuild',
  describe: 'Optimize configuration when building a Docker image',
  builder,
  async handler(argv) {
    const projects = await findDescendantProjects(argv);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    for (const project of prepareForRunningCommand('optimizeForDockerBuild', projects.descendants)) {
      const packageJson: PackageJson = project.packageJson;
      const keys = ['dependencies', 'devDependencies'] as const;
      for (const key of keys) {
        const deps = packageJson[key] ?? {};
        for (const [name, value] of Object.entries(deps)) {
          if (value?.startsWith('git@github.com:')) {
            deps[name] = `./${name}`;
          }
        }
      }

      optimizeDevDependencies(argv, packageJson);

      optimizeScripts(packageJson);

      optimizeDockerInstallPrepareScript(argv, packageJson);

      optimizeRootProps(packageJson);

      if (argv.dryRun) continue;

      const distDirPath = argv.outside ? path.join(project.dirPath, 'dist') : project.dirPath;
      await fs.promises.mkdir(distDirPath, { recursive: true });
      await fs.promises.writeFile(path.join(distDirPath, 'package.json'), JSON.stringify(packageJson), 'utf8');
    }
    if (!argv.dryRun && !argv.outside) {
      child_process.spawnSync(packageManager, ['install'], {
        stdio: 'inherit',
      });
      console.info('Installed dependencies.');
    }
  },
};

function optimizeDevDependencies(argv: InferredOptionTypes<typeof builder>, packageJson: PackageJson): void {
  promoteRuntimeDevDependencies(packageJson);
  if (argv.outside) {
    removeUnnecessaryDevDependenciesForOutsideDockerBuild(packageJson);
    return;
  }

  delete packageJson.devDependencies;
  console.info('Removed all devDependencies.');
}

function removeUnnecessaryDevDependenciesForOutsideDockerBuild(packageJson: PackageJson): void {
  const devDeps = packageJson.devDependencies ?? {};
  // In --outside mode, Docker still runs codegen/build before a second in-image optimization.
  // Remove only tooling that is not needed for that build phase.
  const nameWordsToBeRemoved = [
    'artillery',
    'concurrently',
    'conventional-changelog-conventionalcommits',
    'husky',
    'imagemin',
    'jest',
    'kill-port',
    'lint-staged',
    'open-cli',
    'playwright',
    'prettier',
    'pinst',
    'railway',
    'semantic-release',
    'sort-package-json',
    'wait-on',
    'vitest',
  ];
  const removedDeps: string[] = [];
  for (const name of Object.keys(devDeps)) {
    if (
      nameWordsToBeRemoved.some((word) => name.includes(word)) ||
      (name.includes('willbooster') && name.includes('config'))
    ) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete devDeps[name];
      removedDeps.push(name);
    }
  }
  console.info('Removed devDependencies:', removedDeps.join(', ') || 'none');
}

function promoteRuntimeDevDependencies(packageJson: PackageJson): void {
  const devDeps = packageJson.devDependencies ?? {};
  const dependencies = packageJson.dependencies ?? {};
  const promotedDeps: string[] = [];
  for (const name of runtimeDevDependencies) {
    const version = devDeps[name];
    if (!version) continue;
    if (!dependencies[name]) {
      dependencies[name] = version;
      promotedDeps.push(name);
    }
    delete devDeps[name];
  }
  if (promotedDeps.length > 0) {
    packageJson.dependencies = dependencies;
  }
  console.info('Promoted runtime devDependencies:', promotedDeps.join(', ') || 'none');
}

function optimizeScripts(packageJson: PackageJson): void {
  const nameWordsOfUnnecessaryScripts = ['check', 'deploy', 'format', 'lint', 'start', 'test'];
  const contentWordsOfUnnecessaryScripts = ['pinst ', 'husky '];
  const scripts = (packageJson.scripts ?? {}) as Record<string, string>;
  const removedScripts: string[] = [];
  for (const [name, content] of Object.entries(scripts)) {
    if (
      nameWordsOfUnnecessaryScripts.some((word) => name.startsWith(word)) ||
      // Support "husky" since husky v9 requires `"postinstall": "husky"`
      contentWordsOfUnnecessaryScripts.some((word) => content.includes(word) || content.trim() === word.trim())
    ) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete scripts[name];
      removedScripts.push(name);
    }
  }
  console.info('Removed scripts:', removedScripts.join(', ') || 'none');
}

function optimizeDockerInstallPrepareScript(argv: InferredOptionTypes<typeof builder>, packageJson: PackageJson): void {
  if (!argv.outside || packageManager !== 'bun') return;

  const devDependencyNames = Object.keys(packageJson.devDependencies ?? {});
  if (devDependencyNames.length === 0) return;

  // Bun validates the lockfile even with --production. This script lets Docker rewrite
  // the image-local lockfile after --outside pruning, without hard-coding packages in app Dockerfiles.
  const scripts = packageJson.scripts ?? {};
  scripts['docker/install/prepare'] = `bun remove ${devDependencyNames.join(' ')}`;
  packageJson.scripts = scripts;
  console.info('Added docker/install/prepare script.');
}

function optimizeRootProps(packageJson: PackageJson): void {
  delete packageJson.private;
  delete packageJson.publishConfig;
  delete packageJson.prettier;
}
