import assert from 'node:assert';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isCI, isTruthyEnvValue } from './utils/ci.js';

export type GcMode = 'local' | 'ci';

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
const gitActivityFileNames = ['index', 'HEAD', 'FETCH_HEAD', path.join('logs', 'HEAD')];

// Every message goes to stderr: CI steps capture the stdout of the wb command that triggers GC.

/**
 * Starts `wb gc` once per interval from the outermost wb process: in the background on a developer
 * machine with `WB_AUTO_GC` enabled, and synchronously on a self-hosted CI runner, whose job end
 * kills background processes.
 */
export function startAutoGcIfDue(command: unknown): void {
  if (command === 'gc' || process.env.WB_GC_CHECKED) return;
  process.env.WB_GC_CHECKED = '1';

  // Cleanup is best effort: a failure must never fail the command that triggered it.
  try {
    const mode = detectAutoGcMode();
    if (!mode || !claimAutoGcRun(mode)) return;

    if (mode === 'ci') {
      runGc(mode, false);
    } else {
      startBackgroundGc();
    }
  } catch (error) {
    console.error('wb gc failed:', error);
  }
}

function startBackgroundGc(): void {
  const logPath = path.join(getWbCacheDirPath(), 'gc.log');
  const logFd = fs.openSync(logPath, 'a');
  childProcess
    .spawn(process.execPath, [process.argv[1] ?? '', 'gc'], {
      detached: true,
      env: process.env,
      stdio: ['ignore', logFd, logFd],
    })
    // Spawn failures (e.g., EAGAIN) arrive as an event, outside the caller's try/catch.
    .on('error', (error) => console.error('wb gc failed to start:', error))
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

/**
 * Exclusively creates the stamp of the current interval, so exactly one of concurrently starting wb
 * processes runs GC in each interval.
 */
function claimAutoGcRun(mode: GcMode): boolean {
  // Runners sharing a machine have separate work directories, so each one keeps its own stamps.
  const rootHash = crypto.createHash('sha256').update(getGcRootPath(mode)).digest('hex').slice(0, 16);
  const stampPrefix = `gc-${mode}-${rootHash}-`;
  const interval = Math.floor(Date.now() / autoGcIntervalMs[mode]);
  const stampName = `${stampPrefix}${interval}`;
  const cacheDirPath = getWbCacheDirPath();
  try {
    fs.closeSync(fs.openSync(path.join(cacheDirPath, stampName), 'wx'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }

  // Only older intervals: a claimant delayed past the boundary must not free a newer interval's claim.
  for (const { name } of listDirEntries(cacheDirPath)) {
    if (name.startsWith(stampPrefix) && Number(name.slice(stampPrefix.length)) < interval) {
      fs.rmSync(path.join(cacheDirPath, name), { force: true });
    }
  }
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

export function runGc(mode: GcMode, dryRun: boolean): void {
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
  for (const entry of listDirEntries(workRootPath)) {
    // `_actions`, `_temp`, `_tool`, and the like belong to the runner.
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;

    const workspacePath = path.join(workRootPath, entry.name);
    if (workspacePath === currentWorkspacePath) continue;

    // Anything inside counts, since a job may check out at any `path:` and touch only its Git metadata.
    if (!isModifiedSince(workspacePath, cutoffMs)) {
      removePath(workspacePath, 'CI workspace unmodified for 3 days', context);
    }
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
  // lstat, not stat: a symlinked `.tmp` would redirect removal outside the repository.
  if (!tryLstat(tmpPath)?.isDirectory()) return;

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
  for (const { name: entryName } of listDirEntries(tmpPath)) {
    const entryPath = path.join(tmpPath, entryName);
    if (trackedEntryNames.has(entryName) || isModifiedSince(entryPath, cutoffMs)) continue;

    const blocker = tryLstat(entryPath)?.isDirectory() ? findRemovalBlocker(entryPath) : undefined;
    if (blocker) {
      console.error(`wb gc: kept ${entryPath} because ${blocker}.`);
      continue;
    }
    removedAny = removePath(entryPath, '.tmp entry unmodified for 7 days', context) || removedAny;
  }
  if (removedAny && !context.dryRun) runGit(repoPath, ['worktree', 'prune']);
}

function removeStaleBuildArtifacts(repoPath: string, context: GcContext): void {
  // The command that triggered GC may be about to load this repository's dependencies.
  if (isSameOrInside(context.cwd, tryRealpath(repoPath))) return;

  const cutoffMs = context.nowMs - localArtifactMaxAgeMs;
  if (getRepositoryLastUsedMs(repoPath) >= cutoffMs) return;

  for (const artifactPath of findBuildArtifactDirPaths(repoPath, artifactSearchDepth)) {
    if (!isModifiedSince(artifactPath, cutoffMs)) {
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
 * Removing a worktree keeps its branch commits in its main repository (which may be any
 * repository, not only the enclosing one), but loses commits reachable only from a detached HEAD;
 * removing a main repository loses those of all its worktrees, wherever they are. A directory or
 * repository that cannot be inspected may hide such commits, so it blocks removal as well.
 */
function findRemovalBlocker(dirPath: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return `${dirPath} cannot be read`;
  }
  const blocker = isGitDir(entries)
    ? findGitDirBlocker(dirPath)
    : // Read `.git` from the listing: lstat fails in a directory without the execute bit.
      entries.some((entry) => entry.name === '.git' && !entry.isDirectory())
      ? findLinkedWorktreeBlocker(dirPath)
      : undefined;
  if (blocker) return blocker;

  // Git directories are scanned too: submodules keep theirs under `.git/modules/<name>`.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childBlocker = findRemovalBlocker(path.join(dirPath, entry.name));
    if (childBlocker) return childBlocker;
  }
  return undefined;
}

/** A repository's own `.git`, a submodule's `.git/modules/<name>`, or a bare repository. */
function isGitDir(entries: fs.Dirent[]): boolean {
  return (
    entries.some((entry) => entry.name === 'HEAD' && entry.isFile()) &&
    entries.some((entry) => entry.name === 'objects' && entry.isDirectory())
  );
}

function findLinkedWorktreeBlocker(worktreePath: string): string | undefined {
  const branch = runGit(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === undefined) return `git cannot inspect ${worktreePath}`;
  return branch.trim() === 'HEAD' ? findUnreachableCommitBlocker(worktreePath, [], 'HEAD', worktreePath) : undefined;
}

function findGitDirBlocker(gitDirPath: string): string | undefined {
  const gitDirArgs = ['--git-dir=.'];
  const output = runGit(gitDirPath, [...gitDirArgs, 'worktree', 'list', '--porcelain']);
  if (output === undefined) return `git cannot inspect ${gitDirPath}`;

  for (const block of output.split('\n\n')) {
    const worktreePath = /^worktree (.+)$/m.exec(block)?.[1];
    const head = /^HEAD ([\da-f]+)$/m.exec(block)?.[1];
    if (!worktreePath || !head || !/^detached$/m.test(block)) continue;

    const blocker = findUnreachableCommitBlocker(gitDirPath, gitDirArgs, head, worktreePath);
    if (blocker) return blocker;
  }
  return undefined;
}

function findUnreachableCommitBlocker(
  gitCwd: string,
  gitDirArgs: string[],
  commit: string,
  worktreePath: string
): string | undefined {
  const containingRef = runGit(gitCwd, [
    ...gitDirArgs,
    'for-each-ref',
    '--count=1',
    `--contains=${commit}`,
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  if (containingRef === undefined) return `git cannot inspect ${worktreePath}`;
  return containingRef.trim() ? undefined : `${worktreePath} has commits on no branch, remote-tracking branch, or tag`;
}

function getRepositoryLastUsedMs(repoPath: string): number {
  // The directory's own mtime is no usage signal: removing an entry such as `.tmp` updates it.
  const gitDirPath = resolveGitDirPath(repoPath);
  return Math.max(0, ...gitActivityFileNames.map((fileName) => getMtimeMs(path.join(gitDirPath, fileName)) ?? 0));
}

/** A worktree's `.git` is a file pointing to its git directory. */
function resolveGitDirPath(repoPath: string): string {
  const gitPath = path.join(repoPath, '.git');
  if (!tryLstat(gitPath)?.isFile()) return gitPath;

  const gitDir = /^gitdir: (.+)$/m.exec(fs.readFileSync(gitPath, 'utf8'))?.[1];
  return gitDir ? path.resolve(repoPath, gitDir) : gitPath;
}

function isModifiedSince(entryPath: string, cutoffMs: number): boolean {
  const stat = tryLstat(entryPath);
  if (!stat) return false;
  if (stat.mtimeMs >= cutoffMs) return true;
  if (!stat.isDirectory()) return false;

  return listChildPaths(entryPath).some((childPath) => isModifiedSince(childPath, cutoffMs));
}

/** Returns whether the path was (or, in a dry run, would be) removed; a failure is logged and skipped. */
function removePath(targetPath: string, reason: string, context: GcContext): boolean {
  if (isSameOrInside(context.cwd, resolveWithoutLastSymlink(targetPath))) return false;

  console.error(`wb gc: ${context.dryRun ? 'would remove' : 'removing'} ${targetPath} (${reason})`);
  if (context.dryRun) return true;

  try {
    try {
      fs.rmSync(targetPath, { force: true, recursive: true });
    } catch {
      // Tools leave directories without the owner's write or execute bit (e.g., `__pycache__` with 0600).
      makeOwnerAccessible(targetPath);
      fs.rmSync(targetPath, { force: true, recursive: true });
    }
    return true;
  } catch (error) {
    console.error(`wb gc: failed to remove ${targetPath}:`, error);
    return false;
  }
}

function tryRealpath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

/** Resolves the parent directories only, so a (possibly dangling) symlink stays itself. */
function resolveWithoutLastSymlink(targetPath: string): string {
  try {
    return path.join(fs.realpathSync(path.dirname(targetPath)), path.basename(targetPath));
  } catch {
    return path.resolve(targetPath);
  }
}

function isSameOrInside(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  // A child component may itself start with `..` (e.g., `..worktree`).
  return relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function makeOwnerAccessible(targetPath: string): void {
  const stat = tryLstat(targetPath);
  if (!stat?.isDirectory()) return;

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
  // Git hooks export GIT_DIR, GIT_INDEX_FILE, and the like, which would redirect every call to the
  // hook's repository instead of `cwd`'s.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const result = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8', env });
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
  return tryLstat(targetPath)?.mtimeMs;
}

/** `throwIfNoEntry: false` still throws for other errors, such as ENOTDIR below a regular file. */
function tryLstat(targetPath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(targetPath);
  } catch {
    return undefined;
  }
}

function getAvailableBytes(targetPath: string): number {
  const stat = fs.statfsSync(targetPath);
  return stat.bavail * stat.bsize;
}
