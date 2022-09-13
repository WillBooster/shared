import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { CommandModule, InferredOptionTypes } from 'yargs';

const builder = {
  'working-dir': {
    description: 'A working directory',
    type: 'string',
    default: '.',
    alias: 'w',
  },
} as const;

export const optimizeForDockerBuild: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'optimizeForDockerBuild',
  describe: 'Optimize configuration when building a Docker image',
  builder,
  async handler(argv) {
    const workingDirectory = path.resolve(argv.workingDir);
    const opts = {
      cwd: workingDirectory,
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
    child_process.spawnSync('yarn', ['plugin', 'set', 'remove', '@yarnpkg/plugin-typescript'], opts);
    child_process.spawnSync('yarn', ['plugin', 'set', 'remove', 'plugin-auto-install'], opts);

    const packageJsonPath = path.resolve(workingDirectory, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    const developmentDeps = packageJson.devDependencies;
    if (!developmentDeps) return;

    for (const name of Object.keys(developmentDeps)) {
      const keywords = name.split(/[/@-]/);
      if (
        keywords.includes('eslint') ||
        keywords.includes('jest') ||
        keywords.includes('playwright') ||
        keywords.includes('prettier')
      ) {
        delete developmentDeps[name];
      } else if (name.includes('semantic-release') || (name.includes('willbooster') && name.includes('config'))) {
        delete developmentDeps[name];
      }
    }
    delete developmentDeps['conventional-changelog-conventionalcommits'];
    delete developmentDeps['husky'];
    delete developmentDeps['lint-staged'];
    delete developmentDeps['open-cli'];
    delete developmentDeps['pinst'];
    delete developmentDeps['sort-package-json'];
    delete developmentDeps['wait-on'];

    const scripts = (packageJson.scripts || {}) as Record<string, string>;
    for (const [key, value] of Object.entries(scripts)) {
      if (value.startsWith('husky ') || value.startsWith('pinst ')) {
        delete scripts[key];
      }
    }

    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson), 'utf8');
  },
};
