import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';

import type { CommandModule, InferredOptionTypes, ArgumentsCamelCase } from 'yargs';

import { project } from '../project.js';
import { promisePool } from '../promisePool.js';
import { runWithSpawn, runWithSpawnInParallel } from '../scripts/run.js';
import { preprocessedOptions, sharedOptions } from '../sharedOptions.js';

const builder = {
  ...preprocessedOptions,
  ...sharedOptions,
} as const;

export const setupCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'setup',
  describe: 'Setup development environment',
  builder,
  async handler(argv) {
    await setup(argv);
  },
};

export async function setup(
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof sharedOptions>>>
): Promise<void> {
  const dirents = await fs.readdir(project.dirPath, { withFileTypes: true });
  if (dirents.some((d) => d.isFile() && d.name.includes('-version'))) {
    await runWithSpawn('asdf install', argv);
  }
  if (dirents.some((d) => d.isFile() && d.name === 'pyproject.toml')) {
    await runWithSpawnInParallel('poetry config virtualenvs.in-project true', argv);
    await runWithSpawnInParallel('poetry config virtualenvs.prefer-active-python true', argv);
    const [, version] = child_process.execSync('asdf current python').toString().trim().split(/\s+/);
    await runWithSpawnInParallel(`poetry env use ${version}`, argv);
    await promisePool.promiseAll();
    await runWithSpawn('poetry run pip install --upgrade pip', argv);
    await runWithSpawn('poetry install --ansi', argv);
  }

  if (os.platform() === 'darwin') {
    const packages = ['pstree'];
    if (project.hasDockerfile) {
      packages.push('expect');
    }
    await runWithSpawnInParallel(`brew install ${packages.join(' ')}`, argv);
  }

  const deps = project.packageJson.dependencies ?? {};
  const scripts = project.packageJson.scripts ?? {};
  const newDevDeps: string[] = [];
  if (deps['blitz']) {
    newDevDeps.push('concurrently', 'dotenv-cli', 'open-cli', 'vitest', 'wait-on');
  } else if (deps['express']) {
    newDevDeps.push('concurrently', 'vitest', 'wait-on');
  }
  if (newDevDeps.length > 0) {
    await runWithSpawn(`yarn add -D ${newDevDeps.join(' ')}`, argv);
  }
  if (scripts['gen-code']) {
    await runWithSpawn('yarn gen-code', argv);
  }
}
