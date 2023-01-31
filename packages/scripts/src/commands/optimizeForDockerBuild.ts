import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { CommandModule, InferredOptionTypes } from 'yargs';

import { sharedOptions } from '../sharedOptions.js';

const builder = {
  ...sharedOptions,
  pre: {
    description: 'Whether the optimization is before "docker build" or not',
    type: 'boolean',
    alias: 'p',
  },
} as const;

export const optimizeForDockerBuild: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'optimizeForDockerBuild',
  describe: 'Optimize configuration when building a Docker image',
  builder,
  async handler(argv) {
    if (!argv.pre) {
      const opts = {
        stdio: 'inherit',
      } as const;
      child_process.spawnSync('yarn', ['config', 'set', 'enableTelemetry', '0'], opts);
      child_process.spawnSync('yarn', ['config', 'set', 'enableGlobalCache', '0'], opts);
      child_process.spawnSync('yarn', ['config', 'set', 'nmMode', 'hardlinks-local'], opts);
      const codes = ['YN0007', 'YN0013', 'YN0019'];
      child_process.spawnSync(
        'yarn',
        ['config', 'set', 'logFilters', '--json', JSON.stringify(codes.map((code) => ({ code, level: 'discard' })))],
        opts
      );
      child_process.spawnSync('yarn', ['plugin', 'remove', '@yarnpkg/plugin-typescript'], opts);
      child_process.spawnSync('yarn', ['plugin', 'remove', 'plugin-auto-install'], opts);
    }

    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
    const developmentDeps = packageJson.devDependencies;
    if (!developmentDeps) return;

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
    if (!argv.pre) {
      nameWordsToBeRemoved.push('@types', 'build-ts', 'rollup', 'typefest', 'typescript', 'vite', 'webpack');
    }
    for (const name of Object.keys(developmentDeps)) {
      if (
        nameWordsToBeRemoved.some((word) => name.includes(word)) ||
        (!argv.pre && name.includes('willbooster') && name.includes('config'))
      ) {
        delete developmentDeps[name];
      }
    }

    const nameWordsOfUnnecessaryScripts = ['check', 'format', 'lint', 'start', 'test'];
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

    if (argv.pre) {
      await fs.mkdir('dist', { recursive: true });
    }
    await fs.writeFile(
      argv.pre ? path.join('dist', 'package.json') : 'package.json',
      JSON.stringify(packageJson),
      'utf8'
    );
  },
};
