import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects } from '../project.js';
import { runWithSpawn, runWithSpawnInParallel } from '../scripts/run.js';
import { promisePool } from '../utils/promisePool.js';
import { packageManagerWithRun } from '../utils/runtime.js';

import { prepareForRunningCommand } from './commandUtils.js';

const builder = {} as const;

export const setupCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'setup',
  describe: 'Setup development environment. .env files are ignored.',
  builder,
  async handler(argv) {
    await setup(argv);
  },
};

// Test code requires Partial<...>
export async function setup(
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder>>>,
  projectPathForTesting?: string
): Promise<void> {
  const projects = await findDescendantProjects(argv, false, projectPathForTesting);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    process.exit(1);
  }

  for (const project of prepareForRunningCommand('setup', projects.descendants)) {
    const dirents = await fs.readdir(project.dirPath, { withFileTypes: true });
    if (project === projects.root) {
      if (os.platform() === 'darwin') {
        const packages = ['pstree'];
        if (project.hasDockerfile) {
          packages.push('expect');
        }
        await runWithSpawnInParallel(`brew install ${packages.join(' ')}`, project, argv);
      }

      if (dirents.some((d) => d.isFile() && d.name.includes('-version'))) {
        await runWithSpawn('asdf install', project, argv);
      }
    }

    if (dirents.some((d) => d.isFile() && d.name === 'pyproject.toml')) {
      await runWithSpawnInParallel('poetry config virtualenvs.in-project true', project, argv);
      await runWithSpawnInParallel('poetry config virtualenvs.prefer-active-python true', project, argv);
      const [, version] = child_process.execSync('asdf current python').toString().trim().split(/\s+/);
      await runWithSpawnInParallel(`poetry env use ${version}`, project, argv);
      await promisePool.promiseAll();
      await runWithSpawn('poetry run pip install --upgrade pip', project, argv);
      await runWithSpawn('poetry install --ansi', project, argv);
    }

    if (
      (project === projects.root || !projects.root.packageJson.scripts?.['gen-code']) &&
      project.packageJson.scripts?.['gen-code']
    ) {
      await runWithSpawn(`${packageManagerWithRun} gen-code`, project, argv);
    }
  }

  const project = projects.descendants.find((p) => p.packageJson.devDependencies?.playwright);
  if (project) {
    await runWithSpawn(`${packageManagerWithRun} playwright install --with-deps`, project, argv);
  }
}
