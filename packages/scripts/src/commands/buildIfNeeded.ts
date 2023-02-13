import child_process from 'node:child_process';
import { createHash, Hash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { CommandModule, InferredOptionTypes } from 'yargs';

import { preprocessedOptions } from '../sharedOptions.js';

const builder = {
  ...preprocessedOptions,
  command: {
    description: 'A build command',
    type: 'string',
    default: 'yarn build',
    alias: 'c',
  },
} as const;

export const buildIfNeededCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'buildIfNeeded',
  describe: 'Build code if changes are detected',
  builder,
  async handler(argv) {
    await buildIfNeeded(argv.command);
  },
};

export async function buildIfNeeded(commandWithArgs: string, rootDirPath = '.'): Promise<boolean> {
  const [canSkip, cacheFilePath, contentHash] = await canSkipBuild(rootDirPath);
  if (canSkip) return false;

  console.info('Start building production code.');
  const [command, ...args] = commandWithArgs.split(' ');
  const ret = child_process.spawnSync(command, args, {
    cwd: rootDirPath,
    stdio: 'inherit',
  });
  if (ret.status !== 0) {
    console.info('Failed to build production code.');
    process.exitCode = ret.status ?? 1;
    return false;
  }

  console.info('Finished building production code.');
  await fs.writeFile(cacheFilePath, contentHash, 'utf8');
  return true;
}

export async function canSkipBuild(rootDirPath: string): Promise<[boolean, string, string]> {
  const cacheDirectoryPath = path.resolve(rootDirPath, 'node_modules', '.cache', 'build');
  const cacheFilePath = path.resolve(cacheDirectoryPath, 'last-build');
  await fs.mkdir(cacheDirectoryPath, { recursive: true });

  const hash = createHash('sha256');

  const commitHash = child_process.execSync('git rev-parse HEAD', { cwd: rootDirPath }).toString().trim();
  hash.update(commitHash);

  const environmentJson = JSON.stringify(
    Object.entries(process.env).sort(([key1], [key2]) => key1.localeCompare(key2))
  );
  hash.update(environmentJson);

  await updateHashWithDiffResult(hash, rootDirPath);

  const contentHash = hash.digest('hex');

  try {
    const cachedContentHash = await fs.readFile(cacheFilePath, 'utf8');
    if (cachedContentHash === contentHash) {
      console.info('Skip to build production code.');
      return [true, cacheFilePath, contentHash];
    }
  } catch {
    // do nothing
  }
  return [false, cacheFilePath, contentHash];
}

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
const excludePatterns = ['test/', 'tests/', '__tests__/', 'test-fixtures/', 'package.json'];

async function updateHashWithDiffResult(hash: Hash, rootDirPath: string): Promise<void> {
  return new Promise((resolve) => {
    const ret = child_process.spawnSync('git', ['diff', '--name-only'], {
      cwd: rootDirPath,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    const filePaths = ret.stdout
      .trim()
      .split('\n')
      .map((filePath) =>
        rootDirPath === '.' ? filePath : filePath.replace(/packages\/scripts\/test-fixtures\/[^/]+\//, '')
      );
    const filteredFilePaths = filePaths.filter(
      (filePath) =>
        (includePatterns.some((pattern) => filePath.includes(pattern)) ||
          includeSuffix.some((suffix) => filePath.endsWith(suffix))) &&
        !excludePatterns.some((pattern) => filePath.includes(pattern))
    );

    const proc = child_process.spawn('git', ['diff', '--', ...filteredFilePaths], { cwd: rootDirPath });
    proc.stdout?.on('data', (data) => {
      hash.update(data);
    });
    proc.on('close', () => {
      resolve();
    });
  });
}
