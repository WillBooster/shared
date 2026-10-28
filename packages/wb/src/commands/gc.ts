import assert from 'node:assert';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CommandModule, InferredOptionTypes } from 'yargs';

import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { isCI, isTruthyEnvValue } from '../utils/ci.js';

type GcMode = 'local' | 'ci';

interface GcContext {
  dryRun: boolean;
  nowMs: number;
  /** wb never removes the directory it runs in or any of its ancestors. */
  cwd: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const autoGcIntervalMs: Record<GcMode, number> = { local: DAY_MS, ci: HOUR_MS };
const localTmpEntryMaxAgeMs = 7 * DAY_MS;
const localArtifactMaxAgeMs = 30 * DAY_MS;
const ciWorkspaceMaxAgeMs = 3 * DAY_MS;
// Deep enough for `packages/<name>/node_modules` and `<dir>/native/target`.
const artifactSearchDepth = 3;
const checkoutSearchDepth = 3;
const gitActivityFileNames = ['index', 'HEAD', 'FETCH_HEAD', path.join('logs', 'HEAD')];

// Every message goes to stderr: CI steps capture the stdout of the wb command that triggers GC.
export const gcCommand: CommandModule<unknown, InferredOptionTypes<typeof sharedOptionsBuilder>> = {
  command: 'gc',
  describe:
    'Remove stale temporary files, worktrees, and build artifacts: under the ghq root locally, or stale job workspaces on a self-hosted CI runner.',
  handler(argv) {
    if (isCI(process.env.CI) && !process.env.RUNNER_WORKSPACE) {
      console.error('wb gc: skipped because RUNNER_WORKSPACE is not set on CI.');
      return;
    }
    runGc(isCI(process.env.CI) ? 'ci' : 'local', !!argv.dryRun);
  },
};

/**
 * Starts `wb gc` once per interval from the outermost wb process: in the background on a developer
 * machine with `WB_AUTO_GC` enabled, and synchronously on a self-hosted CI runner, whose job end
 * kills background processes.
 */
export function startAutoGcIfDue(command: unknown): void {
  if (command === 'gc' || process.env.WB_GC_CHECKED) return;
  process.env.WB_GC_CHECKED = '1';

  const mode = detectAutoGcMode();
  if (!mode || !claimAutoGcRun(mode)) return;

  if (mode === 'ci') {
    try {
      runGc(mode, false);
    } catch (error) {
      console.error('wb gc failed:', error);
    }
    return;
  }

  const logPath = path.join(getWbCacheDirPath(), 'gc.log');
  const logFd = fs.openSync(logPath, 'a');
  childProcess
    .spawn(process.execPath, [process.argv[1] ?? '', 'gc'], {
      detached: true,
      env: process.env,
      stdio: ['ignore', logFd, logFd],
    })
    .unref();
  fs.closeSync(logFd);
}

function detectAutoGcMode(): GcMode | undefined {
  if (isCI(process.env.CI)) {
    // GitHub-hosted runners are discarded after each job.
    return process.env.RUNNER_ENVIRONMENT === 'self-hosted' && process.env.RUNNER_WORKSPACE ? 'ci' : undefined;
  }
  return isTruthyEnvValue(process.env.WB_AUTO_GC) ? 'local' : undefined;
}

function claimAutoGcRun(mode: GcMode): boolean {
  // Runners sharing a machine have separate work directories, so each one keeps its own stamp.
  const rootHash = crypto.createHash('sha256').update(getGcRootPath(mode)).digest('hex').slice(0, 16);
  const stampPath = path.join(getWbCacheDirPath(), `gc-${mode}-${rootHash}`);
  const lastRunMs = getMtimeMs(stampPath);
  if (lastRunMs !== undefined && Date.now() - lastRunMs < autoGcIntervalMs[mode]) return false;

  fs.writeFileSync(stampPath, '');
  return true;
}

function getWbCacheDirPath(): string {
  const dirPath = path.join(os.homedir(), '.cache', 'wb');
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getGcRootPath(mode: GcMode): string {
  if (mode === 'ci') return path.dirname(getCurrentCiWorkspacePath());
  return path.resolve(process.env.GHQ_ROOT ?? path.join(os.homedir(), 'ghq'));
}

function getCurrentCiWorkspacePath(): string {
  assert.ok(process.env.RUNNER_WORKSPACE, 'RUNNER_WORKSPACE must be set on CI.');
  return path.resolve(process.env.RUNNER_WORKSPACE);
}

function runGc(mode: GcMode, dryRun: boolean): void {
  const rootPath = getGcRootPath(mode);
  console.error(`wb gc: cleaning ${rootPath} (${mode}) at ${new Date().toISOString()}${dryRun ? ' (dry run)' : ''}.`);
  if (!fs.existsSync(rootPath)) {
    console.error(`wb gc: skipped because ${rootPath} does not exist.`);
    return;
  }

  const context: GcContext = { dryRun, nowMs: Date.now(), cwd: fs.realpathSync(process.cwd()) };
  const availableBytesBefore = getAvailableBytes(rootPath);
  if (mode === 'ci') {
    removeStaleCiWorkspaces(rootPath, context);
  } else {
    for (const repoPath of listGhqRepositories(rootPath)) {
      removeStaleTmpEntries(repoPath, context);
      removeStaleBuildArtifacts(repoPath, context);
    }
  }
  // Last, so that versions referenced only by the removed directories' configs are pruned too.
  pruneMise(dryRun);

  if (!dryRun) {
    const freedGb = (getAvailableBytes(rootPath) - availableBytesBefore) / 1024 ** 3;
    console.error(`wb gc: freed ${Math.max(freedGb, 0).toFixed(1)} GB.`);
  }
}

/**
 * Each job checks out into `<work>/<repo>/<repo>`, and one runner runs one job at a time, so every
 * workspace but the current job's is idle; actions/checkout re-creates a removed one.
 */
function removeStaleCiWorkspaces(workRootPath: string, context: GcContext): void {
  const currentWorkspacePath = getCurrentCiWorkspacePath();
  const cutoffMs = context.nowMs - ciWorkspaceMaxAgeMs;
  for (const entry of fs.readdirSync(workRootPath, { withFileTypes: true })) {
    // `_actions`, `_temp`, `_tool`, and the like belong to the runner.
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;

    const workspacePath = path.join(workRootPath, entry.name);
    if (workspacePath === currentWorkspacePath) continue;

    const checkoutPaths = listChildDirPaths(workspacePath);
    const lastUsedMs = Math.max(
      getMtimeMs(workspacePath) ?? 0,
      ...checkoutPaths.map((checkoutPath) => getRepositoryLastUsedMs(checkoutPath))
    );
    if (lastUsedMs < cutoffMs) removePath(workspacePath, 'CI workspace unused for 3 days', context);
  }
}

function listGhqRepositories(rootPath: string): string[] {
  const repoPaths: string[] = [];
  for (const hostPath of listChildDirPaths(rootPath)) {
    for (const ownerPath of listChildDirPaths(hostPath)) {
      for (const repoPath of listChildDirPaths(ownerPath)) {
        if (fs.existsSync(path.join(repoPath, '.git'))) repoPaths.push(repoPath);
      }
    }
  }
  return repoPaths;
}

function removeStaleTmpEntries(repoPath: string, context: GcContext): void {
  const tmpPath = path.join(repoPath, '.tmp');
  if (!fs.existsSync(tmpPath)) return;

  const trackedFiles = runGit(repoPath, ['ls-files', '-z', '--', '.tmp']);
  // Without the tracked file list, tracked files cannot be told apart from disposable ones.
  if (trackedFiles === undefined) return;

  const trackedEntryNames = new Set(
    trackedFiles
      .split('\0')
      .filter(Boolean)
      .map((filePath) => filePath.split('/')[1])
  );
  const cutoffMs = context.nowMs - localTmpEntryMaxAgeMs;
  let removedAny = false;
  for (const entryName of fs.readdirSync(tmpPath)) {
    const entryPath = path.join(tmpPath, entryName);
    if (trackedEntryNames.has(entryName) || isModifiedSince(entryPath, cutoffMs)) continue;

    const worktreePath = findWorktreeWithUnreachableHead(entryPath, checkoutSearchDepth);
    if (worktreePath) {
      console.error(`wb gc: kept ${entryPath} because ${worktreePath} has commits on no branch or tag.`);
      continue;
    }
    removedAny = removePath(entryPath, '.tmp entry unmodified for 7 days', context) || removedAny;
  }
  if (removedAny) runGit(repoPath, ['worktree', 'prune']);
}

function removeStaleBuildArtifacts(repoPath: string, context: GcContext): void {
  const cutoffMs = context.nowMs - localArtifactMaxAgeMs;
  if (getRepositoryLastUsedMs(repoPath) >= cutoffMs) return;

  for (const artifactPath of findBuildArtifactDirPaths(repoPath, artifactSearchDepth)) {
    const lastModifiedMs = Math.max(...[artifactPath, ...listChildPaths(artifactPath)].map((p) => getMtimeMs(p) ?? 0));
    if (lastModifiedMs < cutoffMs) {
      removePath(artifactPath, 'build artifact in a repository unused for 30 days', context);
    }
  }
}

/** `node_modules` and cache directories marked by a `CACHEDIR.TAG` file (e.g., Cargo's `target`). */
function findBuildArtifactDirPaths(dirPath: string, depth: number): string[] {
  const artifactPaths: string[] = [];
  for (const childPath of listChildDirPaths(dirPath)) {
    const name = path.basename(childPath);
    if (name === 'node_modules' || fs.existsSync(path.join(childPath, 'CACHEDIR.TAG'))) {
      artifactPaths.push(childPath);
    } else if (depth > 1 && !name.startsWith('.')) {
      artifactPaths.push(...findBuildArtifactDirPaths(childPath, depth - 1));
    }
  }
  return artifactPaths;
}

/**
 * Removing a worktree keeps its branch commits in the main repository, but loses commits reachable
 * only from a detached HEAD.
 */
function findWorktreeWithUnreachableHead(dirPath: string, depth: number): string | undefined {
  const gitPath = path.join(dirPath, '.git');
  const isWorktree = fs.lstatSync(gitPath, { throwIfNoEntry: false })?.isFile();
  if (isWorktree && runGit(dirPath, ['symbolic-ref', '-q', 'HEAD']) === undefined) {
    const containingRef = runGit(dirPath, [
      'for-each-ref',
      '--count=1',
      '--contains=HEAD',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ]);
    if (!containingRef?.trim()) return dirPath;
  }
  if (depth <= 1) return undefined;

  for (const childPath of listChildDirPaths(dirPath)) {
    if (path.basename(childPath) === 'node_modules') continue;
    const worktreePath = findWorktreeWithUnreachableHead(childPath, depth - 1);
    if (worktreePath) return worktreePath;
  }
  return undefined;
}

function getRepositoryLastUsedMs(repoPath: string): number {
  // The directory's own mtime is no usage signal: removing an entry such as `.tmp` updates it.
  const gitDirPath = resolveGitDirPath(repoPath);
  return Math.max(0, ...gitActivityFileNames.map((fileName) => getMtimeMs(path.join(gitDirPath, fileName)) ?? 0));
}

/** A worktree's `.git` is a file pointing to its git directory. */
function resolveGitDirPath(repoPath: string): string {
  const gitPath = path.join(repoPath, '.git');
  if (!fs.lstatSync(gitPath, { throwIfNoEntry: false })?.isFile()) return gitPath;

  const gitDir = /^gitdir: (.+)$/m.exec(fs.readFileSync(gitPath, 'utf8'))?.[1];
  return gitDir ? path.resolve(repoPath, gitDir) : gitPath;
}

function isModifiedSince(entryPath: string, cutoffMs: number): boolean {
  const stat = fs.lstatSync(entryPath, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.mtimeMs >= cutoffMs) return true;
  if (!stat.isDirectory()) return false;

  return listChildPaths(entryPath).some((childPath) => isModifiedSince(childPath, cutoffMs));
}

function removePath(targetPath: string, reason: string, context: GcContext): boolean {
  const relativeToCwd = path.relative(fs.realpathSync(targetPath), context.cwd);
  if (!relativeToCwd.startsWith('..') && !path.isAbsolute(relativeToCwd)) return false;

  console.error(`wb gc: ${context.dryRun ? 'would remove' : 'removing'} ${targetPath} (${reason})`);
  if (context.dryRun) return true;

  try {
    fs.rmSync(targetPath, { force: true, recursive: true });
  } catch {
    // Tools leave directories without the owner's write or execute bit (e.g., `__pycache__` with 0600).
    makeOwnerAccessible(targetPath);
    fs.rmSync(targetPath, { force: true, recursive: true });
  }
  return true;
}

function makeOwnerAccessible(targetPath: string): void {
  const stat = fs.lstatSync(targetPath);
  if (!stat.isDirectory()) return;

  fs.chmodSync(targetPath, stat.mode | 0o700);
  for (const childPath of listChildPaths(targetPath)) makeOwnerAccessible(childPath);
}

function pruneMise(dryRun: boolean): void {
  const dryRunArgs = dryRun ? ['--dry-run'] : [];
  for (const args of [
    ['prune', '--yes', ...dryRunArgs],
    ['cache', 'prune', ...dryRunArgs],
  ]) {
    const result = childProcess.spawnSync('mise', args, { stdio: ['ignore', 'pipe', 'inherit'] });
    process.stderr.write(result.stdout ?? '');
    if (result.error) {
      console.error(`wb gc: skipped \`mise ${args.join(' ')}\`: ${result.error.message}`);
      return;
    }
  }
}

function runGit(cwd: string, args: string[]): string | undefined {
  const result = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : undefined;
}

function listChildDirPaths(dirPath: string): string[] {
  return listDirEntries(dirPath)
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dirPath, entry.name));
}

function listChildPaths(dirPath: string): string[] {
  return listDirEntries(dirPath).map((entry) => path.join(dirPath, entry.name));
}

function listDirEntries(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function getMtimeMs(targetPath: string): number | undefined {
  try {
    return fs.lstatSync(targetPath).mtimeMs;
  } catch {
    return undefined;
  }
}

function getAvailableBytes(targetPath: string): number {
  const stat = fs.statfsSync(targetPath);
  return stat.bavail * stat.bsize;
}
