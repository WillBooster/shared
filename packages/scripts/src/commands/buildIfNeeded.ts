import child_process from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { CommandModule, InferredOptionTypes } from 'yargs';

import { sharedOptions } from '../sharedOptions.js';

const builder = {
  ...sharedOptions,
  command: {
    description: 'A build command',
    type: 'string',
    default: 'yarn build',
    alias: 'c',
  },
} as const;

export const buildIfNeeded: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'buildIfNeeded',
  describe: 'Build code if changes are detected',
  builder,
  async handler(argv) {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));

    const cacheDirectoryPath = path.resolve('node_modules', '.cache', 'build');
    const cacheFilePath = path.resolve(cacheDirectoryPath, 'last-build');
    await fs.mkdir(cacheDirectoryPath, { recursive: true });

    const commitHash = child_process.execSync('git rev-parse HEAD').toString().trim();
    const environmentJson = JSON.stringify(
      Object.entries(process.env).sort(([key1], [key2]) => key1.localeCompare(key2))
    );
    delete (packageJson as Record<string, unknown>).scripts;

    const entries = await fs.readdir('.');
    const diff = child_process
      .execSync(`git diff ${entries.join(' ')}`)
      .toString()
      .trim();
    const content = commitHash + environmentJson + diff + JSON.stringify(packageJson);

    const hash = createHash('sha256');
    hash.update(content);
    const contentHash = hash.digest('hex');

    try {
      const cachedContentHash = await fs.readFile(cacheFilePath, 'utf8');
      if (cachedContentHash === contentHash) {
        console.log('Skip to build production code.');
        return;
      }
    } catch {
      // do nothing
    }

    console.log('Start building production code.');
    const [command, ...args] = argv.command.split(' ');
    child_process.spawnSync(command, args, {
      stdio: 'inherit',
    });
    console.log('Finished building production code.');

    await fs.writeFile(cacheFilePath, contentHash, 'utf8');
  },
};
