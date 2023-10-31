import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';

import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import { findAllProjects } from '../project.js';
import { promisePool } from '../promisePool.js';
import { runWithSpawn, runWithSpawnInParallel } from '../scripts/run.js';

import { prepareForRunningCommand } from './commandUtils.js';

const builder = {} as const;

export const setupCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'setup',
  describe: 'Setup development environment',
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
  const projects = await findAllProjects(argv, projectPathForTesting);
  if (!projects) return;

  for (const project of prepareForRunningCommand('setup', projects.all)) {
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

    const deps = project.packageJson.dependencies ?? {};
    const devDeps = project.packageJson.devDependencies || {};
    const scripts = project.packageJson.scripts ?? {};
    const newDeps: string[] = [];
    const newDevDeps: string[] = [];
    if (deps['blitz'] || deps['next']) {
      newDeps.push('pm2');
      newDevDeps.push('concurrently', 'open-cli', 'vitest', 'wait-on');
    } else if (devDeps['@remix-run/dev']) {
      newDeps.push('pm2');
      newDevDeps.push('concurrently', 'open-cli', 'vitest', 'wait-on');
    } else if (deps['express'] || deps['fastify']) {
      newDeps.push('pm2');
      newDevDeps.push('concurrently', 'vitest', 'wait-on');
    }
    if (newDeps.length > 0) {
      await runWithSpawn(`yarn add ${newDeps.join(' ')}`, project, argv);
    }
    if (newDevDeps.length > 0) {
      await runWithSpawn(`yarn add -D ${newDevDeps.join(' ')}`, project, argv);
    }
    if (scripts['gen-code']) {
      await runWithSpawn('yarn gen-code', project, argv);
    }
  }
}
