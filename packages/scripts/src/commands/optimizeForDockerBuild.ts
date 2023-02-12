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
  post: {
    description: 'Whether the optimization is before "docker build" or not',
    type: 'boolean',
    alias: 'p',
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

    if (!argv.outside && !argv.post) {
      child_process.spawnSync('yarn', ['plugin', 'remove', 'plugin-auto-install'], opts);
      child_process.spawnSync('yarn', ['config', 'set', 'enableTelemetry', '0'], opts);
      child_process.spawnSync('yarn', ['config', 'set', 'enableGlobalCache', '0'], opts);
      child_process.spawnSync('yarn', ['config', 'set', 'nmMode', 'hardlinks-local'], opts);
      const codes = ['YN0007', 'YN0013', 'YN0019'];
      child_process.spawnSync(
        'yarn',
        ['config', 'set', 'logFilters', '--json', JSON.stringify(codes.map((code) => ({ code, level: 'discard' })))],
        opts
      );
    }

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
    if (argv.post) {
      // Seed scripts require TypeScript-related packages.
      nameWordsToBeRemoved.push('build-ts', 'rollup', 'vite', 'webpack');
    }
    for (const name of Object.keys(developmentDeps)) {
      if (
        nameWordsToBeRemoved.some((word) => name.includes(word)) ||
        (argv.post && name.includes('willbooster') && name.includes('config'))
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

    if (argv.post) {
      child_process.spawnSync('yarn', opts);
    }
  },
};
