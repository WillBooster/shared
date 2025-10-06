import child_process from 'node:child_process';
import type { BinaryLike, Hash } from 'node:crypto';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ignoreEnoentAsync } from '@willbooster/shared-lib/src';
import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findSelfProject } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { isRunningOnBun } from '../utils/runtime.js';

const builder = {
  command: {
    description: 'A build command (default: yarn|bun build)',
    type: 'string',
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
  // Test code requires Partial<...>
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>>>,
  projectPathForTesting?: string
): Promise<boolean | undefined> {
  const project = findSelfProject(argv, true, projectPathForTesting);
  if (!project) {
    console.error(chalk.red('No project found.'));
    return true;
  }

  argv = { ...argv, command: argv.command ?? (isRunningOnBun ? 'bun run build' : 'yarn build') };

  if (!fs.existsSync(path.join(project.rootDirPath, '.git'))) {
    build(project, argv);
    return true;
  }

  const [canSkip, cacheFilePath, contentHash] = await canSkipBuild(project, argv);
  if (canSkip) {
    console.info(chalk.green(`Skip to run '${argv.command}' 💫`));
    return false;
  }

  if (!build(project, argv)) return;

  if (!argv.dryRun) {
    await fs.promises.writeFile(cacheFilePath, contentHash, 'utf8');
  }
  return true;
}

function build(project: Project, argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder>>>): boolean {
  console.info(chalk.green(`Run '${argv.command}'`));
  if (!argv.dryRun) {
    const ret = child_process.spawnSync(argv.command ?? '', {
      cwd: project.dirPath,
      env: project.env,
      shell: true,
      stdio: 'inherit',
    });
    if (ret.status !== 0) {
      process.exitCode = ret.status ?? 1;
      return false;
    }
  }
  return true;
}

const ignoringEnvVarNames = new Set(['CI', 'PWDEBUG', 'TMPDIR']);

export async function canSkipBuild(
  project: Project,
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder>>>
): Promise<[boolean, string, string]> {
  const cacheDirectoryPath = path.resolve(project.dirPath, 'node_modules', '.cache', 'build');
  const cacheFilePath = path.resolve(cacheDirectoryPath, 'last-build');
  await fs.promises.mkdir(cacheDirectoryPath, { recursive: true });

  const hash = createHash('sha256');

  const commitHash = child_process.execSync('git rev-parse HEAD', { cwd: project.dirPath }).toString().trim();
  hash.update(commitHash);

  const environmentJson = JSON.stringify(
    Object.entries(project.env)
      .filter(([key]) => !ignoringEnvVarNames.has(key))
      .toSorted(([key1], [key2]) => key1.localeCompare(key2))
  );
  hash.update(environmentJson);

  await updateHashWithDiffResult(project, argv, hash);
  const contentHash = hash.digest('hex');

  const cachedContentHash = await ignoreEnoentAsync(() => fs.promises.readFile(cacheFilePath, 'utf8'));
  return [cachedContentHash === contentHash, cacheFilePath, contentHash];
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
  // Because some build commands affected by changes in `package.json`
  'package.json',
  'yarn.lock',
];
const excludePatterns = ['test/', 'tests/', '__tests__/', 'test-fixtures/', 'test/fixtures/'];

async function updateHashWithDiffResult(
  project: Project,
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder>>>,
  hash: Hash
): Promise<void> {
  return new Promise((resolve) => {
    const ret = child_process.spawnSync('git', ['diff', '--name-only'], {
      cwd: project.dirPath,
      env: project.env,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    const filePaths = ret.stdout
      .trim()
      .split('\n')
      .map((filePath) =>
        project.env.WB_ENV === 'test' ? filePath.replace(/packages\/wb\/test\/fixtures\/[^/]+\//, '') : filePath
      );
    const filteredFilePaths = filePaths.filter(
      (filePath) =>
        (includePatterns.some((pattern) => filePath.includes(pattern)) ||
          includeSuffix.some((suffix) => filePath.endsWith(suffix))) &&
        !excludePatterns.some((pattern) => filePath.includes(pattern))
    );
    if (argv.verbose) {
      console.info(`Changed files: ${filteredFilePaths.join(', ')}`);
    }

    // 'git diff --' works only on rootDirPath
    const proc = child_process.spawn('git', ['diff', '--', ...filteredFilePaths], { cwd: project.rootDirPath });
    proc.stdout.on('data', (data: BinaryLike) => {
      hash.update(data);
      if (argv.verbose) {
        console.info('Data:', data);
        console.info('Hash:', hash.copy().digest('hex'));
      }
    });
    proc.on('close', () => {
      resolve();
    });
  });
}
