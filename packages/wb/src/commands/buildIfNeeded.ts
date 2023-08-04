import child_process from 'node:child_process';
import type { Hash } from 'node:crypto';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import { project } from '../project.js';
import { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

const builder = {
  ...sharedOptionsBuilder,
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
    await buildIfNeeded(argv);
  },
};

export async function buildIfNeeded(
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder>>>
): Promise<boolean> {
  const [canSkip, cacheFilePath, contentHash] = await canSkipBuild();
  if (canSkip) return false;

  if (!argv.dryRun) {
    const [command, ...args] = (argv.command ?? '').split(' ');
    const ret = child_process.spawnSync(command, args, {
      cwd: project.dirPath,
      stdio: 'inherit',
    });
    if (ret.status !== 0) {
      process.exitCode = ret.status ?? 1;
      return false;
    }
  }

  if (!argv.dryRun) {
    await fs.writeFile(cacheFilePath, contentHash, 'utf8');
  }
  return true;
}

const ignoringEnvVarNames = new Set(['CI', 'PWDEBUG', 'TMPDIR']);

export async function canSkipBuild(): Promise<[boolean, string, string]> {
  const cacheDirectoryPath = path.resolve(project.dirPath, 'node_modules', '.cache', 'build');
  const cacheFilePath = path.resolve(cacheDirectoryPath, 'last-build');
  await fs.mkdir(cacheDirectoryPath, { recursive: true });

  const hash = createHash('sha256');

  const commitHash = child_process.execSync('git rev-parse HEAD', { cwd: project.dirPath }).toString().trim();
  hash.update(commitHash);

  const environmentJson = JSON.stringify(
    Object.entries(process.env)
      .filter(([key]) => !ignoringEnvVarNames.has(key))
      .sort(([key1], [key2]) => key1.localeCompare(key2))
  );
  hash.update(environmentJson);

  await updateHashWithDiffResult(hash);

  const contentHash = hash.digest('hex');

  try {
    const cachedContentHash = await fs.readFile(cacheFilePath, 'utf8');
    if (cachedContentHash === contentHash) {
      console.info(chalk.green('Skip to build code 💫'));
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

async function updateHashWithDiffResult(hash: Hash): Promise<void> {
  return new Promise((resolve) => {
    const ret = child_process.spawnSync('git', ['diff', '--name-only'], {
      cwd: project.dirPath,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    const filePaths = ret.stdout
      .trim()
      .split('\n')
      .map((filePath) =>
        process.env.WB_ENV === 'test' ? filePath.replace(/packages\/scripts\/test-fixtures\/[^/]+\//, '') : filePath
      );
    const filteredFilePaths = filePaths.filter(
      (filePath) =>
        (includePatterns.some((pattern) => filePath.includes(pattern)) ||
          includeSuffix.some((suffix) => filePath.endsWith(suffix))) &&
        !excludePatterns.some((pattern) => filePath.includes(pattern))
    );

    const proc = child_process.spawn('git', ['diff', '--', ...filteredFilePaths], { cwd: project.dirPath });
    proc.stdout?.on('data', (data) => {
      hash.update(data);
    });
    proc.on('close', () => {
      resolve();
    });
  });
}
