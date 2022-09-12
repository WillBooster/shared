import fs from 'node:fs/promises';

import type { CommandModule, InferredOptionTypes } from 'yargs';

const builder = {} as const;

export const optimizeDepsForDocker: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'optimizeDepsForDocker',
  describe: 'Optimize devDependencies for building a Docker image',
  builder,
  async handler() {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
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

    await fs.writeFile('package.json', JSON.stringify(packageJson));
  },
};
