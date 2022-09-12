import fs from 'node:fs/promises';

import type { CommandModule, InferredOptionTypes } from 'yargs';

const builder = {} as const;

export const optimizeDepsForDocker: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'optimizeDepsForDocker',
  describe: 'Optimize devDependencies for building a Docker image',
  builder,
  async handler(argv) {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
    const developmentDeps = packageJson.devDependencies;
    if (!developmentDeps) return;

    delete developmentDeps['@playwright/test'];
    delete developmentDeps['conventional-changelog-conventionalcommits'];
    delete developmentDeps['jest'];
    delete developmentDeps['jest-watch-typeahead'];
    delete developmentDeps['open-cli'];
    delete developmentDeps['playwright'];
    delete developmentDeps['semantic-release'];
    delete developmentDeps['sort-package-json'];
    await fs.writeFile('package.json', JSON.stringify(packageJson));
  },
};
