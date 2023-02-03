import fs from 'node:fs/promises';

import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { blitzScripts } from '../scripts/blitzScripts.js';
import { runScript } from '../scripts/sharedScripts.js';

const builder = {
  docker: {
    description: 'Start app on docker',
    type: 'boolean',
    alias: 'd',
  },
} as const;

export const start: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'start',
  describe: 'Start app',
  builder,
  async handler(argv) {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
    const name = packageJson.name || 'unknown';
    if (packageJson.dependencies?.['blitz']) {
      process.exitCode = await (argv.docker
        ? runScript(
            `
${blitzScripts.buildDocker(name)}
  && yarn concurrently --raw --kill-others-on-fail
    "${blitzScripts.startDocker(name)}"
    "${blitzScripts.waitAndOpenApp(8080)}"
`
          )
        : runScript(
            `
yarn concurrently --raw --kill-others-on-fail
  "blitz dev"
  "${blitzScripts.waitAndOpenApp()}");
`
          ));
    }
  },
};
