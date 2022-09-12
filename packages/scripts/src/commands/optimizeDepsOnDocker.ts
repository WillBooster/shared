import fs from 'node:fs/promises';

import type { CommandModule, InferredOptionTypes } from 'yargs';

const builder = {} as const;

export const optimizeDepsOnDocker: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'optimizeDepsOnDocker',
  describe: 'Optimize devDependencies for building a Docker image',
  builder,
  async handler(argv) {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf-8'));
    const devDeps = packageJson.devDependencies;
    if (!devDeps) return;

    delete devDeps['@playwright/test'];
    delete devDeps['conventional-changelog-conventionalcommits'];
    delete devDeps['jest'];
    delete devDeps['jest-watch-typeahead'];
    delete devDeps['open-cli'];
    delete devDeps['playwright'];
    delete devDeps['semantic-release'];
    delete devDeps['sort-package-json'];
    await fs.writeFile('package.json', JSON.stringify(packageJson));
  },
};
