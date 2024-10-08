import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects } from '../project.js';
import { packageManager } from '../utils/runtime.js';

import { prepareForRunningCommand } from './commandUtils.js';

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
        const deps = packageJson[key] || {};
        for (const [name, value] of Object.entries(deps)) {
          if (value?.startsWith('git@github.com:')) {
            deps[name] = `./${name}`;
          }
        }
      }

      optimizeDevDependencies(argv, packageJson);

      optimizeScripts(packageJson);

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
  if (!argv.outside) {
    delete packageJson.devDependencies;
    console.info('Removed all devDependencies.');
    return;
  }

  const devDeps = packageJson.devDependencies || {};
  const nameWordsToBeRemoved = [
    'artillery',
    'concurrently',
    'conventional-changelog-conventionalcommits',
    'eslint',
    'husky',
    'imagemin',
    'jest',
    'kill-port',
    'lint-staged',
    'open-cli',
    'playwright',
    'prettier',
    'pinst',
    'sort-package-json',
    'wait-on',
    'semantic-release',
    'vitest',
  ];
  const removedDeps: string[] = [];
  for (const name of Object.keys(devDeps)) {
    if (
      nameWordsToBeRemoved.some((word) => name.includes(word)) ||
      (!argv.outside && name.includes('willbooster') && name.includes('config'))
    ) {
      delete devDeps[name];
      removedDeps.push(name);
    }
  }
  console.info('Removed devDependencies:', removedDeps.join(', ') || 'none');
}

function optimizeScripts(packageJson: PackageJson): void {
  const nameWordsOfUnnecessaryScripts = ['check', 'deploy', 'format', 'lint', 'start', 'test'];
  const contentWordsOfUnnecessaryScripts = ['pinst ', 'husky '];
  const scripts = (packageJson.scripts || {}) as Record<string, string>;
  const removedScripts: string[] = [];
  for (const [name, content] of Object.entries(scripts)) {
    if (
      nameWordsOfUnnecessaryScripts.some((word) => name.includes(word)) ||
      // Support "husky" since husky v9 requires `"postinstall": "husky"`
      contentWordsOfUnnecessaryScripts.some((word) => content.includes(word) || content.trim() === word.trim())
    ) {
      delete scripts[name];
      removedScripts.push(name);
    }
  }
  console.info('Removed scripts:', removedScripts.join(', ') || 'none');
}

function optimizeRootProps(packageJson: PackageJson): void {
  delete packageJson.private;
  delete packageJson.publishConfig;
  delete packageJson.prettier;
}
