import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';

import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { promisePool } from '../promisePool.js';
import { runWithSpawn, runWithSpawnInParallel } from '../scripts/run.js';
import { preprocessedOptions } from '../sharedOptions.js';

const builder = {
  ...preprocessedOptions,
  init: {
    description: 'Whether or not to setup a project initially',
    type: 'boolean',
    alias: 'i',
  },
} as const;

export const setupCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'setup',
  describe: 'Setup development environment',
  builder,
  async handler(argv) {
    const packageJsonPromise = fs.readFile('package.json', 'utf8');

    const dirents = await fs.readdir('.', { withFileTypes: true });
    if (dirents.some((d) => d.isFile() && d.name.includes('-version'))) {
      await runWithSpawn('asdf install');
    }
    if (dirents.some((d) => d.isFile() && d.name === 'pyproject.toml')) {
      await runWithSpawnInParallel('poetry config virtualenvs.in-project true');
      await runWithSpawnInParallel('poetry config virtualenvs.prefer-active-python true');
      const [, version] = child_process.execSync('asdf current python').toString().trim().split(/\s+/);
      await runWithSpawnInParallel(`poetry env use ${version}`);
      await promisePool.promiseAll();
      await runWithSpawn('poetry run pip install --upgrade pip');
      await runWithSpawn('poetry install --ansi');
    }

    const packageJson = JSON.parse(await packageJsonPromise) as PackageJson;
    const deps = packageJson.dependencies ?? {};
    const scripts = packageJson.scripts ?? {};
    if (deps['blitz']) {
      if (os.platform() === 'darwin') {
        await runWithSpawnInParallel('brew install unbuffer');
      }
      if (argv.init) {
        await runWithSpawnInParallel('yarn add -D concurrently dotenv-cli open-cli retry-cli wait-on');
      }
      if (scripts['gen-code']) {
        await runWithSpawnInParallel('yarn gen-code');
      }
      await promisePool.promiseAll();
    }
  },
};
