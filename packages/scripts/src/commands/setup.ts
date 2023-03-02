import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';

import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import { project } from '../project.js';
import { promisePool } from '../promisePool.js';
import { runWithSpawn, runWithSpawnInParallel } from '../scripts/run.js';
import { preprocessedOptions } from '../sharedOptions.js';

const builder = {
  ...preprocessedOptions,
} as const;

export const setupCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'setup',
  describe: 'Setup development environment',
  builder,
  async handler(argv) {
    await setup(argv);
  },
};

export async function setup(argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder>>>): Promise<void> {
  const dirents = await fs.readdir(project.dirPath, { withFileTypes: true });
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

  if (os.platform() === 'darwin') {
    const packages = ['pstree'];
    if (project.hasDockerfile) {
      packages.push('expect');
    }
    await runWithSpawnInParallel(`brew install ${packages.join(' ')}`);
  }

  const deps = project.packageJson.dependencies ?? {};
  const scripts = project.packageJson.scripts ?? {};
  const newDevDeps: string[] = [];
  if (project.hasDockerfile) {
    newDevDeps.push('retry-cli');
  }
  if (deps['blitz']) {
    newDevDeps.push('concurrently', 'dotenv-cli', 'open-cli', 'vitest', 'wait-on');
  } else if (deps['express']) {
    newDevDeps.push('concurrently', 'vitest', 'wait-on');
  }
  if (newDevDeps.length > 0) {
    await runWithSpawn(`yarn add -D ${newDevDeps.join(' ')}`);
  }
  if (scripts['gen-code']) {
    await runWithSpawn('yarn gen-code');
  }
}
