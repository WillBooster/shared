import child_process from 'node:child_process';
import { createHash, Hash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { PackageJson } from 'type-fest';
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
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;

    const cacheDirectoryPath = path.resolve('node_modules', '.cache', 'build');
    const cacheFilePath = path.resolve(cacheDirectoryPath, 'last-build');
    await fs.mkdir(cacheDirectoryPath, { recursive: true });

    const hash = createHash('sha256');

    const commitHash = child_process.execSync('git rev-parse HEAD').toString().trim();
    hash.update(commitHash);

    const environmentJson = JSON.stringify(
      Object.entries(process.env).sort(([key1], [key2]) => key1.localeCompare(key2))
    );
    hash.update(environmentJson);

    const build = packageJson.scripts?.['build'] || '';
    delete packageJson.scripts;
    packageJson.scripts = { build };
    hash.update(JSON.stringify(packageJson));

    await updateHashWithDiffResult(hash);

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

const includePatterns = ['src/', 'public/'];
const includeSuffix = [
  '.js',
  '.cjs',
  '.mjs',
  '.jsx',
  '.ts',
  '.cts',
  '.mts',
  '.tsx',
  '.json',
  '.browserslistrc',
  'yarn.lock',
];
const excludePatterns = ['/test/', '/tests/', '/__tests__/', '/test-fixtures/'];

async function updateHashWithDiffResult(hash: Hash): Promise<void> {
  return new Promise((resolve) => {
    const ret = child_process.spawnSync('git', ['diff', '--name-only'], { stdio: 'pipe', encoding: 'utf8' });
    const filePaths = ret.stdout
      .trim()
      .split('\n')
      .filter(
        (filePath) =>
          (includePatterns.some((pattern) => filePath.includes(pattern)) ||
            includeSuffix.some((suffix) => filePath.endsWith(suffix))) &&
          !excludePatterns.some((pattern) => filePath.includes(pattern))
      );

    const proc = child_process.spawn('git', ['diff', '--', ...filePaths]);
    proc.stdout?.on('data', (data) => {
      hash.update(data);
    });
    proc.on('close', () => {
      resolve();
    });
  });
}
