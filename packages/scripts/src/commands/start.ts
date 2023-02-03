import fs from 'node:fs/promises';

import { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { blitzScripts } from '../scripts/blitzScripts.js';
import { runScript } from '../scripts/sharedScripts.js';

const builder = {
  mode: {
    description: 'Start mode: dev | prod | docker',
    type: 'string',
    alias: 'm',
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
      switch (argv.mode) {
        case 'dev': {
          process.exitCode = await runScript(
            `
yarn concurrently --raw --kill-others-on-fail
  "blitz dev"
  "${blitzScripts.waitAndOpenApp()}");
`
          );
          break;
        }
        case 'prod': {
          process.exitCode = await runScript(
            `
yarn db:setup && yarn build && yarn blitz start -p \${PORT:-8080}
`,
            {
              env: {
                ...process.env,
                NODE_ENV: 'production',
              },
            }
          );
          break;
        }
        case 'docker': {
          process.exitCode = await runScript(
            `
${blitzScripts.buildDocker(name)}
  && yarn concurrently --raw --kill-others-on-fail
    "${blitzScripts.startDocker(name)}"
    "${blitzScripts.waitAndOpenApp(8080)}"
`
          );
          break;
        }
        default: {
          throw new Error(`Unknown start mode: ${argv.mode}`);
        }
      }
    }
  },
};
