import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { CommandModule, InferredOptionTypes } from 'yargs';

import { preprocessedOptions } from '../sharedOptions.js';

const builder = {
  ...preprocessedOptions,
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

    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));

    const deps = packageJson.dependencies || {};
    if (deps['@moti-components/go-e-mon']) {
      deps['@moti-components/go-e-mon'] = './@moti-components/go-e-mon';
    }
    if (deps['online-judge-shared']) {
      deps['online-judge-shared'] = './online-judge-shared';
    }

    const developmentDeps = packageJson.devDependencies || {};
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
    if (!argv.outside) {
      // Seed scripts require TypeScript-related packages.
      nameWordsToBeRemoved.push('build-ts', 'rollup', 'vite', 'webpack');
    }
    for (const name of Object.keys(developmentDeps)) {
      if (
        nameWordsToBeRemoved.some((word) => name.includes(word)) ||
        (!argv.outside && name.includes('willbooster') && name.includes('config'))
      ) {
        delete developmentDeps[name];
      }
    }

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

    if (argv.outside) {
      await fs.mkdir('dist', { recursive: true });
    }
    await fs.writeFile(
      argv.outside ? path.join('dist', 'package.json') : 'package.json',
      JSON.stringify(packageJson),
      'utf8'
    );

    if (!argv.outside) {
      child_process.spawnSync('yarn', opts);
    }
  },
};
