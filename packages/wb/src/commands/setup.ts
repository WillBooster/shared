import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects } from '../project.js';
import { runWithSpawn, runWithSpawnInParallel } from '../scripts/run.js';
import { promisePool } from '../utils/promisePool.js';

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
        await runWithSpawnInParallel(`brew install ${packages.join(' ')}`, project, argv);
      }

      if (dirents.some((d) => d.isFile() && (d.name === 'mise.toml' || d.name.includes('-version')))) {
        await runWithSpawn('mise install', project, argv, { exitIfFailed: false });
      }
    }

    if (dirents.some((d) => d.isFile() && d.name === 'pyproject.toml')) {
      await runWithSpawnInParallel('poetry config virtualenvs.in-project true', project, argv);
      // `mise which python` resolves the project's ACTIVE interpreter to a single absolute path,
      // unlike `mise current python`, which prints every configured version (mise supports
      // multi-version pins) and would pass extra positional arguments to `poetry env use`.
      let pythonPath = '';
      try {
        pythonPath = child_process
          .execSync('mise which python', { cwd: project.dirPath, stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim();
      } catch {
        // mise missing or python unconfigured; let poetry pick its default interpreter.
      }
      if (pythonPath) {
        // The command runs through a shell; POSIX single quotes keep the path one literal argument
        // even when a relocated mise data dir puts metacharacters into it.
        const quotedPythonPath = `'${pythonPath.replaceAll("'", String.raw`'\''`)}'`;
        await runWithSpawnInParallel(`poetry env use ${quotedPythonPath}`, project, argv);
      }
      await promisePool.promiseAll();
      await runWithSpawn('poetry run pip install --upgrade pip', project, argv);
      await runWithSpawn('poetry install --ansi', project, argv);
    }

    if (
      (project === projects.root || !projects.root.packageJson.scripts?.['gen-code']) &&
      project.packageJson.scripts?.['gen-code']
    ) {
      await runWithSpawn(`${project.packageManagerRunCommand} gen-code`, project, argv);
    }
  }

  const project = projects.descendants.find((p) => p.packageJson.devDependencies?.playwright);
  if (project) {
    await runWithSpawn(`${project.packageManagerRunCommand} playwright install --with-deps`, project, argv);
  }
}
