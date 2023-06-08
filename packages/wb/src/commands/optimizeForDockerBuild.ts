import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { project } from '../project.js';
import { preprocessedOptions, sharedOptions } from '../sharedOptions.js';

const builder = {
  ...preprocessedOptions,
  ...sharedOptions,
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
    const opts = {
      stdio: 'inherit',
    } as const;

    const packageJsonPaths = ['package.json'];
    if (project.packageJson.workspaces) {
      const packageDirs = await fs.promises.readdir('packages', { withFileTypes: true });
      for (const packageDir of packageDirs) {
        if (!packageDir.isDirectory()) continue;

        const packageJsonPath = path.join('packages', packageDir.name, 'package.json');
        if (!fs.existsSync(packageJsonPath)) continue;

        packageJsonPaths.push(packageJsonPath);
      }
    }

    for (const packageJsonPath of packageJsonPaths) {
      const packageJson: PackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const deps = packageJson.dependencies || {};
      if (deps['@discord-bot/llm'] && deps['@discord-bot/llm'] !== 'workspace:*') {
        deps['@discord-bot/llm'] = './@discord-bot/llm';
      }
      if (deps['@moti-components/go-e-mon']) {
        deps['@moti-components/go-e-mon'] = './@moti-components/go-e-mon';
      }
      if (deps['@online-judge/shared']) {
        deps['@online-judge/shared'] = './@online-judge/shared';
      }
      if (deps['program-executor']) {
        deps['program-executor'] = './program-executor';
      }
      // TODO: remove after migrating from online-judge-shared to @online-judge/shared
      if (deps['online-judge-shared']) {
        deps['online-judge-shared'] = './online-judge-shared';
      }

      optimizeDevDependencies(argv, packageJson);

      optimizeScripts(packageJson);

      if (argv.dry) continue;

      const distDirPath = path.join(path.dirname(packageJsonPath), 'dist');
      if (argv.outside) {
        await fs.promises.mkdir(distDirPath, { recursive: true });
      }
      await fs.promises.writeFile(
        argv.outside ? path.join(distDirPath, 'package.json') : 'package.json',
        JSON.stringify(packageJson),
        'utf8'
      );
    }
    if (!argv.dry && !argv.outside) {
      child_process.spawnSync('yarn', opts);
    }
  },
};

function optimizeDevDependencies(argv: InferredOptionTypes<typeof builder>, packageJson: PackageJson): void {
  if (!argv.outside) {
    delete packageJson.devDependencies;
    return;
  }

  const devDeps = packageJson.devDependencies || {};
  const nameWordsToBeRemoved = [
    'concurrently',
    'conventional-changelog-conventionalcommits',
    'eslint',
    'husky',
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
  for (const name of Object.keys(devDeps)) {
    if (
      nameWordsToBeRemoved.some((word) => name.includes(word)) ||
      (!argv.outside && name.includes('willbooster') && name.includes('config'))
    ) {
      delete devDeps[name];
    }
  }
}

function optimizeScripts(packageJson: PackageJson): void {
  const nameWordsOfUnnecessaryScripts = ['check', 'deploy', 'format', 'lint', 'start', 'test'];
  const contentWordsOfUnnecessaryScripts = ['pinst ', 'husky '];
  const scripts = (packageJson.scripts || {}) as Record<string, string>;
  for (const [name, content] of Object.entries(scripts)) {
    if (
      nameWordsOfUnnecessaryScripts.some((word) => name.includes(word)) ||
      contentWordsOfUnnecessaryScripts.some((word) => content.includes(word))
    ) {
      delete scripts[name];
    }
  }
}
