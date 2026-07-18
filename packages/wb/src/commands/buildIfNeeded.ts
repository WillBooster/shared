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

const builder = {
  command: {
    description: 'A build command (default: yarn|bun build)',
    type: 'string',
    alias: 'c',
  },
  output: {
    description:
      'Build output paths (relative to the project directory) that must exist for the cache to be valid (default: auto-detected common output directories)',
    type: 'array',
    alias: 'o',
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

  const buildCommand =
    argv.command ?? (project.packageJson.scripts?.build ? `${project.packageManagerRunCommand} build` : undefined);
  if (!buildCommand) {
    console.info(chalk.green('Skip to build because no build command is defined.'));
    return false;
  }
  argv = { ...argv, command: buildCommand };

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
    const outputPaths = getExplicitOutputPaths(argv) ?? detectExistingDefaultOutputPaths(project);
    if (outputPaths.length === 0) {
      // With no recorded outputs, a deleted build directory can never invalidate the cache; make
      // the inactive protection visible instead of failing silently (cf. issue #981).
      console.info(
        chalk.yellow('No build output directory detected; pass --output to enable missing-output cache invalidation.')
      );
    }
    await fs.promises.writeFile(cacheFilePath, JSON.stringify({ hash: contentHash, outputPaths }), 'utf8');
  }
  return true;
}

// Common build output directories used across org projects (vinext/build-ts emit dist,
// Next.js emits .next, CRA-style apps emit build, `next export` emits out).
const defaultOutputCandidates = ['dist', 'build', '.next', 'out'];

function getExplicitOutputPaths(
  argv: Partial<ArgumentsCamelCase<InferredOptionTypes<typeof builder>>>
): string[] | undefined {
  return argv.output?.length ? argv.output.map(String) : undefined;
}

function detectExistingDefaultOutputPaths(project: Project): string[] {
  return defaultOutputCandidates.filter((outputPath) => fs.existsSync(path.join(project.dirPath, outputPath)));
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

  // The invoked build command is part of the cache identity: `-c commandB` must not reuse a
  // cache recorded for commandA with otherwise unchanged inputs.
  hash.update(argv.command ?? '');

  const environmentJson = JSON.stringify(
    Object.entries(project.env)
      .filter(([key]) => !ignoringEnvVarNames.has(key))
      .toSorted(([key1], [key2]) => key1.localeCompare(key2))
  );
  hash.update(environmentJson);

  await updateHashWithDiffResult(project, argv, hash);
  const contentHash = hash.digest('hex');

  const cachedContent = await ignoreEnoentAsync(() => fs.promises.readFile(cacheFilePath, 'utf8'));
  const cache = parseBuildCache(cachedContent);
  if (cache?.hash !== contentHash) return [false, cacheFilePath, contentHash];

  // The cache is valid only while the recorded (or explicitly requested) build outputs still
  // exist: a deleted output directory (e.g. `rm -rf dist`) must trigger a rebuild even when the
  // inputs are unchanged (https://github.com/WillBooster/shared/issues/981).
  const requiredOutputPaths = getExplicitOutputPaths(argv) ?? cache.outputPaths;
  const missingOutputPaths = requiredOutputPaths.filter(
    (outputPath) => !fs.existsSync(path.resolve(project.dirPath, outputPath))
  );
  if (missingOutputPaths.length > 0) {
    console.info(chalk.yellow(`Rebuilding because build outputs are missing: ${missingOutputPaths.join(', ')}`));
    return [false, cacheFilePath, contentHash];
  }
  return [true, cacheFilePath, contentHash];
}

function parseBuildCache(cachedContent: string | undefined): { hash: string; outputPaths: string[] } | undefined {
  if (!cachedContent) return;
  try {
    const parsed = JSON.parse(cachedContent) as { hash?: unknown; outputPaths?: unknown } | undefined;
    if (typeof parsed?.hash !== 'string') return;
    const outputPaths = Array.isArray(parsed.outputPaths)
      ? parsed.outputPaths.filter((p) => typeof p === 'string')
      : [];
    return { hash: parsed.hash, outputPaths };
  } catch {
    // A legacy cache file contains a raw content hash without output records. Treat it as a miss:
    // honoring it would let a matching hash skip a build whose outputs were deleted, and one
    // rebuild upgrades the record to the JSON format.
    return;
  }
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
    // `-uall` lists untracked files individually (not just their directory), so new files in a
    // brand-new source directory participate in the hash below.
    const ret = child_process.spawnSync('git', ['status', '--porcelain', '-uall'], {
      cwd: project.dirPath,
      env: project.env,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    const statusEntries = ret.stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const rawPath = line.slice(2).trim();
        return {
          untracked: line.startsWith('??'),
          // Renames are reported as `old -> new`; only the new path exists in the worktree.
          filePath: rawPath.includes(' -> ') ? (rawPath.split(' -> ').at(-1) ?? rawPath) : rawPath,
        };
      })
      .map((entry) => ({
        ...entry,
        hashPath:
          project.env.WB_ENV === 'test'
            ? entry.filePath.replace(/packages\/wb\/test\/fixtures\/[^/]+\//, '')
            : entry.filePath,
      }));
    const filteredEntries = statusEntries.filter(
      ({ hashPath }) =>
        (includePatterns.some((pattern) => hashPath.includes(pattern)) ||
          includeSuffix.some((suffix) => hashPath.endsWith(suffix))) &&
        !excludePatterns.some((pattern) => hashPath.includes(pattern))
    );
    if (argv.verbose) {
      console.info(`Changed files: ${filteredEntries.map((entry) => entry.hashPath).join(', ')}`);
    }

    // Untracked files never appear in `git diff`, so hash their contents directly.
    for (const entry of filteredEntries.filter((entry) => entry.untracked)) {
      try {
        hash.update(entry.hashPath);
        hash.update(fs.readFileSync(path.join(project.rootDirPath, entry.filePath)));
      } catch {
        // The file may vanish concurrently; the tracked-state diff below is unaffected.
      }
    }

    const trackedPaths = filteredEntries.filter((entry) => !entry.untracked).map((entry) => entry.hashPath);
    if (trackedPaths.length === 0) {
      // `git diff HEAD --` with no pathspec would diff EVERY file, letting excluded changes
      // (docs, tests) invalidate the cache.
      resolve();
      return;
    }
    // `git diff HEAD` (not plain `git diff`) so staged-only changes invalidate the cache too;
    // 'git diff --' works only on rootDirPath.
    const proc = child_process.spawn('git', ['diff', 'HEAD', '--', ...trackedPaths], { cwd: project.rootDirPath });
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
