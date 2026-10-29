import { describe, expect, it } from 'bun:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempDir } from '../helpers/shared.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Root bypasses permission bits, so unreadable fixtures stay readable for it.
const honorsPermissions = process.getuid?.() !== 0;
const cliPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

describe('wb gc', () => {
  it('removes stale .tmp entries and artifacts of unused repositories under the ghq root', () => {
    const tempDirPath = createTempDir();
    const ghqRootPath = path.join(tempDirPath, 'ghq');
    const activeRepoPath = createRepository(path.join(ghqRootPath, 'github.com', 'owner', 'active'));
    const unusedRepoPath = createRepository(path.join(ghqRootPath, 'github.com', 'owner', 'unused'));
    const invokingRepoPath = createRepository(path.join(ghqRootPath, 'github.com', 'owner', 'invoking'));
    const lockedRepoPath = createRepository(path.join(ghqRootPath, 'github.com', 'owner', 'locked'));

    git(activeRepoPath, 'worktree', 'add', '-q', '-b', 'feature', '.tmp/branch-worktree');
    const detachedWorktreePath = path.join(activeRepoPath, '.tmp', 'session', 'a', 'b', 'detached-worktree');
    git(activeRepoPath, 'worktree', 'add', '-q', '--detach', detachedWorktreePath);
    git(detachedWorktreePath, 'commit', '-q', '--allow-empty', '-m', 'detached');
    const foreignRepoPath = createRepository(path.join(tempDirPath, 'foreign'));
    const foreignWorktreePath = path.join(activeRepoPath, '.tmp', 'foreign-session', 'worktree');
    git(foreignRepoPath, 'worktree', 'add', '-q', '--detach', foreignWorktreePath);
    git(foreignWorktreePath, 'commit', '-q', '--allow-empty', '-m', 'detached');
    writeFile(path.join(activeRepoPath, '.tmp', 'stale', 'log.txt'));
    writeFile(path.join(activeRepoPath, '.tmp', 'stale.log'));
    const cloneRepoPath = createRepository(path.join(activeRepoPath, '.tmp', 'clone'));
    // Git permits blank lines in worktree paths.
    const cloneWorktreePath = path.join(activeRepoPath, '.tmp', 'clone\n\nworktree');
    git(cloneRepoPath, 'worktree', 'add', '-q', '--detach', cloneWorktreePath);
    git(cloneWorktreePath, 'commit', '-q', '--allow-empty', '-m', 'detached');
    const branchCloneRepoPath = createRepository(path.join(activeRepoPath, '.tmp', 'a-branch-clone'));
    git(
      branchCloneRepoPath,
      'worktree',
      'add',
      '-q',
      '-b',
      'feature',
      path.join(activeRepoPath, '.tmp', 'b-branch-worktree')
    );
    const submoduleSourcePath = createRepository(path.join(tempDirPath, 'submodule-source'));
    const superprojectPath = createRepository(path.join(activeRepoPath, '.tmp', 'superproject'));
    git(superprojectPath, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submoduleSourcePath, 'sub');
    const submoduleWorktreePath = path.join(tempDirPath, 'submodule-worktree');
    git(path.join(superprojectPath, 'sub'), 'worktree', 'add', '-q', '--detach', submoduleWorktreePath);
    git(submoduleWorktreePath, 'commit', '-q', '--allow-empty', '-m', 'detached');
    const lockedDirPath = path.join(activeRepoPath, '.tmp', 'unreadable', 'locked');
    writeFile(path.join(lockedDirPath, 'inner', 'file'));
    fs.symlinkSync(path.join(tempDirPath, 'missing'), path.join(activeRepoPath, '.tmp', 'dangling'));
    writeFile(path.join(activeRepoPath, '.tmp', 'tracked', 'keep.txt'));
    git(activeRepoPath, 'add', '-f', '.tmp/tracked/keep.txt');
    git(activeRepoPath, 'commit', '-q', '-m', 'track a .tmp file');
    writeFile(path.join(activeRepoPath, 'node_modules', 'pkg', 'index.js'));
    writeFile(path.join(unusedRepoPath, 'node_modules', 'pkg', 'index.js'));
    writeFile(path.join(unusedRepoPath, 'native', 'target', 'CACHEDIR.TAG'));
    writeFile(path.join(invokingRepoPath, 'node_modules', 'pkg', 'index.js'));
    writeFile(path.join(lockedRepoPath, 'target', 'CACHEDIR.TAG'));
    writeFile(path.join(lockedRepoPath, '.tmp', 'old.log'));
    setOld(tempDirPath, 60);
    writeFile(path.join(activeRepoPath, '.tmp', 'recent', 'log.txt'));
    for (const fileName of ['index', 'HEAD']) setNow(path.join(activeRepoPath, '.git', fileName));

    fs.chmodSync(lockedDirPath, 0o600);
    fs.chmodSync(path.join(lockedRepoPath, '.git'), 0o600);
    fs.mkdirSync(path.join(invokingRepoPath, '.tmp'));
    fs.chmodSync(path.join(invokingRepoPath, '.tmp'), 0o000);
    // As exported by a Git hook of another repository that runs wb.
    const result = runWbGc(invokingRepoPath, {
      GHQ_ROOT: ghqRootPath,
      GIT_DIR: path.join(foreignRepoPath, '.git'),
      GIT_INDEX_FILE: path.join(foreignRepoPath, '.git', 'index'),
      HOME: tempDirPath,
    });
    unlock(lockedDirPath);
    unlock(path.join(lockedRepoPath, '.git'));
    unlock(path.join(invokingRepoPath, '.tmp'));

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(activeRepoPath, '.tmp', 'stale'))).toBe(false);
    expect(fs.existsSync(path.join(activeRepoPath, '.tmp', 'stale.log'))).toBe(false);
    expect(fs.lstatSync(path.join(activeRepoPath, '.tmp', 'dangling'), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.existsSync(path.join(activeRepoPath, '.tmp', 'branch-worktree'))).toBe(false);
    expect(git(activeRepoPath, 'worktree', 'list')).not.toContain('branch-worktree');
    expect(git(activeRepoPath, 'branch', '--list', 'feature')).toContain('feature');
    expect(fs.existsSync(detachedWorktreePath)).toBe(true);
    expect(fs.existsSync(foreignWorktreePath)).toBe(true);
    if (honorsPermissions) {
      expect(fs.existsSync(lockedDirPath)).toBe(true);
      expect(result.stderr).toContain(
        `kept what contains ${path.join(lockedDirPath, 'inner')} because it cannot be inspected`
      );
    }
    expect(fs.existsSync(cloneRepoPath)).toBe(true);
    expect(fs.existsSync(cloneWorktreePath)).toBe(true);
    expect(fs.existsSync(superprojectPath)).toBe(true);
    expect(fs.existsSync(branchCloneRepoPath)).toBe(false);
    expect(fs.existsSync(path.join(activeRepoPath, '.tmp', 'b-branch-worktree'))).toBe(false);
    expect(fs.existsSync(path.join(invokingRepoPath, 'node_modules'))).toBe(true);
    if (honorsPermissions) {
      expect(fs.existsSync(path.join(lockedRepoPath, 'target'))).toBe(true);
      expect(result.stderr).toContain(`skipped ${path.join(invokingRepoPath, '.tmp')} because it cannot be listed`);
      expect(result.stderr).toContain(`skipped ${path.join(lockedRepoPath, '.tmp')} because git cannot list`);
    }
    expect(fs.existsSync(path.join(activeRepoPath, '.tmp', 'tracked', 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(activeRepoPath, '.tmp', 'recent'))).toBe(true);
    expect(fs.existsSync(path.join(activeRepoPath, 'node_modules'))).toBe(true);
    expect(fs.existsSync(path.join(unusedRepoPath, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(unusedRepoPath, 'native', 'target'))).toBe(false);
    expect(fs.existsSync(path.join(unusedRepoPath, 'native'))).toBe(true);
  }, 60_000);

  it('removes clean worktrees in .tmp after 1 day but keeps changed and recent ones', () => {
    const tempDirPath = createTempDir();
    const ghqRootPath = path.join(tempDirPath, 'ghq');
    const repoPath = createRepository(path.join(ghqRootPath, 'github.com', 'owner', 'repo'));
    for (const name of ['clean', 'modified', 'untracked', 'recent']) {
      git(repoPath, 'worktree', 'add', '-q', '-b', name, `.tmp/${name}`);
      writeFile(path.join(repoPath, '.tmp', name, 'tracked.txt'));
      git(path.join(repoPath, '.tmp', name), 'add', 'tracked.txt');
      git(path.join(repoPath, '.tmp', name), 'commit', '-q', '-m', 'add');
    }
    fs.writeFileSync(path.join(repoPath, '.tmp', 'clean', '.gitignore'), 'node_modules\n');
    git(path.join(repoPath, '.tmp', 'clean'), 'add', '.gitignore');
    git(path.join(repoPath, '.tmp', 'clean'), 'commit', '-q', '-m', 'ignore');
    writeFile(path.join(repoPath, '.tmp', 'clean', 'node_modules', 'pkg', 'index.js'));
    fs.writeFileSync(path.join(repoPath, '.tmp', 'modified', 'tracked.txt'), 'changed');
    writeFile(path.join(repoPath, '.tmp', 'untracked', 'new.txt'));
    writeFile(path.join(repoPath, '.tmp', 'stale-log', 'log.txt'));
    setOld(path.join(repoPath, '.tmp'), 2);
    setNow(path.join(repoPath, '.tmp', 'recent', 'tracked.txt'));

    const result = runWbGc(repoPath, { GHQ_ROOT: ghqRootPath, HOME: tempDirPath });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(repoPath, '.tmp', 'clean'))).toBe(false);
    expect(git(repoPath, 'branch', '--list', 'clean')).toContain('clean');
    expect(fs.existsSync(path.join(repoPath, '.tmp', 'modified'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.tmp', 'untracked'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.tmp', 'recent'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.tmp', 'stale-log'))).toBe(true);
  }, 60_000);

  it('removes stale workspaces of other jobs on a CI runner once per interval', () => {
    const tempDirPath = createTempDir();
    const workRootPath = path.join(tempDirPath, '_work');
    const currentWorkspacePath = path.join(workRootPath, 'current');
    const currentCheckoutPath = createRepository(path.join(currentWorkspacePath, 'current'));
    fs.writeFileSync(path.join(currentCheckoutPath, 'package.json'), JSON.stringify({ name: 'current' }));
    createRepository(path.join(workRootPath, 'stale', 'stale'));
    createRepository(path.join(workRootPath, 'recent', 'src', 'recent'));
    writeFile(path.join(workRootPath, '_tool', 'node', 'bin'));
    const lockedGitPath = path.join(createRepository(path.join(workRootPath, 'locked', 'locked')), '.git');
    setOld(tempDirPath, 10);
    setNow(path.join(lockedGitPath, 'index'));
    fs.chmodSync(lockedGitPath, 0o600);
    setNow(path.join(workRootPath, 'recent', 'src', 'recent', '.git', 'FETCH_HEAD'));
    const env = {
      CI: 'true',
      HOME: tempDirPath,
      RUNNER_TEMP: path.join(workRootPath, '_temp'),
      RUNNER_WORKSPACE: currentWorkspacePath,
    };

    const firstRunHour = getCurrentHour();
    const result = runWb(currentCheckoutPath, ['kill-port-if-non-ci'], env);
    unlock(lockedGitPath);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(workRootPath, 'stale'))).toBe(false);
    expect(fs.existsSync(currentWorkspacePath)).toBe(true);
    expect(fs.existsSync(path.join(workRootPath, 'recent'))).toBe(true);
    expect(fs.existsSync(path.join(workRootPath, '_tool'))).toBe(true);
    if (honorsPermissions) expect(fs.existsSync(path.join(workRootPath, 'locked'))).toBe(true);

    createRepository(path.join(workRootPath, 'another', 'another'));
    setOld(path.join(workRootPath, 'another'), 10);
    expect(runWb(currentCheckoutPath, ['kill-port-if-non-ci'], env).status).toBe(0);
    // CI intervals are clock-aligned hours, so a second run in the next hour legitimately cleans again.
    if (getCurrentHour() === firstRunHour) expect(fs.existsSync(path.join(workRootPath, 'another'))).toBe(true);

    createRepository(path.join(workRootPath, 'misconfigured', 'misconfigured'));
    setOld(path.join(workRootPath, 'misconfigured'), 10);
    const misconfiguredResult = runWb(currentCheckoutPath, ['gc'], { ...env, RUNNER_TEMP: tempDirPath });
    expect(misconfiguredResult.status).toBe(0);
    expect(fs.existsSync(path.join(workRootPath, 'misconfigured'))).toBe(true);
  }, 60_000);
});

function getCurrentHour(): number {
  return Math.floor(Date.now() / (60 * 60 * 1000));
}

function runWbGc(cwd: string, env: Record<string, string>): childProcess.SpawnSyncReturns<string> {
  return runWb(cwd, ['gc'], { CI: '', ...env });
}

/** Runs from a temporary directory, so mise finds no configuration of the host's ancestor directories. */
function runWb(cwd: string, args: string[], env: Record<string, string>): childProcess.SpawnSyncReturns<string> {
  const miseDirPath = path.join(env.HOME ?? '', 'mise');
  const result = childProcess.spawnSync('bun', [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      WB_GC_CHECKED: '',
      MISE_CACHE_DIR: path.join(miseDirPath, 'cache'),
      MISE_CONFIG_DIR: path.join(miseDirPath, 'config'),
      MISE_GLOBAL_CONFIG_FILE: path.join(miseDirPath, 'config', 'config.toml'),
      MISE_DATA_DIR: path.join(miseDirPath, 'data'),
      MISE_STATE_DIR: path.join(miseDirPath, 'state'),
      ...env,
    },
  });
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  return result;
}

function createRepository(repoPath: string): string {
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repoPath, 'fetch', '-q', '.', 'main');
  return repoPath;
}

function git(cwd: string, ...args: string[]): string {
  // Background auto-maintenance would create and delete lock files while `setOld` walks the tree.
  const configArgs = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'maintenance.auto=false'];
  return childProcess.execFileSync('git', [...configArgs, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
}

function setOld(targetPath: string, days: number): void {
  const time = new Date(Date.now() - days * DAY_MS);
  for (const entry of fs.readdirSync(targetPath, { recursive: true, withFileTypes: true })) {
    fs.lutimesSync(path.join(entry.parentPath, entry.name), time, time);
  }
  fs.lutimesSync(targetPath, time, time);
}

/** Root may have removed the fixture, since permission bits do not stop it. */
function unlock(targetPath: string): void {
  if (fs.existsSync(targetPath)) fs.chmodSync(targetPath, 0o700);
}

function setNow(targetPath: string): void {
  fs.utimesSync(targetPath, new Date(), new Date());
}
