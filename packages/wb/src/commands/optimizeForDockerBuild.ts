import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

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

    const deps = project.packageJson.dependencies || {};
    if (deps['@moti-components/go-e-mon']) {
      deps['@moti-components/go-e-mon'] = './@moti-components/go-e-mon';
    }
    if (deps['online-judge-shared']) {
      deps['online-judge-shared'] = './online-judge-shared';
    }
    if (deps['program-executor']) {
      deps['program-executor'] = './program-executor';
    }

    if (argv.outside) {
      const devDeps = project.packageJson.devDependencies || {};
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
    } else {
      delete project.packageJson.devDependencies;
    }

    const nameWordsOfUnnecessaryScripts = ['check', 'deploy', 'format', 'lint', 'start', 'test'];
    const contentWordsOfUnnecessaryScripts = ['pinst ', 'husky '];
    const scripts = (project.packageJson.scripts || {}) as Record<string, string>;
    for (const [name, content] of Object.entries(scripts)) {
      if (
        nameWordsOfUnnecessaryScripts.some((word) => name.includes(word)) ||
        contentWordsOfUnnecessaryScripts.some((word) => content.includes(word))
      ) {
        delete scripts[name];
      }
    }

    if (argv.dry) return;

    if (argv.outside) {
      await fs.mkdir('dist', { recursive: true });
    }
    await fs.writeFile(
      argv.outside ? path.join('dist', 'package.json') : 'package.json',
      JSON.stringify(project.packageJson),
      'utf8'
    );

    if (!argv.outside) {
      child_process.spawnSync('yarn', opts);
    }
  },
};
