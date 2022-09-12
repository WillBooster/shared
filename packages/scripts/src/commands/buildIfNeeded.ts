import child_process from 'child_process';
import { createHash } from 'crypto';
import fs from 'node:fs/promises';
import path from 'path';

import type { CommandModule, InferredOptionTypes } from 'yargs';

const builder = {
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
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf-8'));

    const cacheDirPath = path.resolve('node_modules', '.cache', 'build');
    const cacheFilePath = path.resolve(cacheDirPath, 'last-build');
    await fs.mkdir(cacheDirPath, { recursive: true });

    const commitHash = child_process.execSync('git rev-parse HEAD').toString().trim();
    const envJson = JSON.stringify(Object.entries(process.env).sort(([key1], [key2]) => key1.localeCompare(key2)));
    delete (packageJson as any).scripts;

    const entries = await fs.readdir('.');
    const diff = child_process
      .execSync(`git diff ${entries.join(' ')}`)
      .toString()
      .trim();
    const content = commitHash + envJson + diff + JSON.stringify(packageJson);

    const hash = createHash('sha256');
    hash.update(content);
    const contentHash = hash.digest('hex');

    try {
      const cachedContentHash = await fs.readFile(cacheFilePath, 'utf-8');
      if (cachedContentHash === contentHash) {
        console.log('Skip to build production code.');
        return;
      }
    } catch (_) {
      // do nothing
    }

    console.log('Start building production code.');
    child_process.spawnSync(argv.command, {
      stdio: 'inherit',
    });
    console.log('Finished building production code.');

    await fs.writeFile(cacheFilePath, contentHash, 'utf-8');
  },
};
