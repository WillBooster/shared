import child_process from 'node:child_process';
import type { Hash } from 'node:crypto';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ignoreEnoentAsync } from '@willbooster/shared-lib/src';
import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findAllProjects } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

import { prepareForRunningCommand } from './commandUtils.js';

const builder = {
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

function build(project: Project, argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder>>>): boolean {
  console.info(chalk.green(`Run '${argv.command}'`));
  if (!argv.dryRun) {
    const ret = child_process.spawnSync(argv.command ?? '', {
      cwd: project.dirPath,
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

export async function buildIfNeeded(
  // Test code requires Partial<...>
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>>>,
  projectPathForTesting?: string
): Promise<boolean | undefined> {
  const projects = await findAllProjects(argv, projectPathForTesting);
  if (!projects) return true;

  const isGitRepo = fs.existsSync(path.join(projects.root.dirPath, '.git'));

  let built = false;
  for (const project of prepareForRunningCommand('buildIfNeeded', projects.all)) {
    if (!isGitRepo) {
      if (!build(project, argv)) return;
      built = true;
      continue;
    }

    const [canSkip, cacheFilePath, contentHash] = await canSkipBuild(project, argv);
    if (canSkip) {
      console.info(chalk.green(`Skip to run '${argv.command}' 💫`));
      continue;
    }

    if (!build(project, argv)) return;
    built = true;

    if (!argv.dryRun) {
      await fs.promises.writeFile(cacheFilePath, contentHash, 'utf8');
    }
  }
  return built;
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
      .sort(([key1], [key2]) => key1.localeCompare(key2))
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
  'yarn.lock',
];
const excludePatterns = ['test/', 'tests/', '__tests__/', 'test-fixtures/', 'package.json'];

async function updateHashWithDiffResult(
  project: Project,
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder>>>,
  hash: Hash
): Promise<void> {
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
        project.env.WB_ENV === 'test' ? filePath.replace(/packages\/scripts\/test-fixtures\/[^/]+\//, '') : filePath
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
    proc.stdout?.on('data', (data) => {
      hash.update(data);
      if (argv.verbose) {
        console.info(data.toString());
        console.info('Hash:', hash.copy().digest('hex'));
      }
    });
    proc.on('close', () => {
      resolve();
    });
  });
}
