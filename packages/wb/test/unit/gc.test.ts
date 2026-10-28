import { describe, expect, it } from 'bun:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createTempDir } from '../helpers/shared.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('wb gc', () => {
  it('removes stale .tmp entries and artifacts of unused repositories under the ghq root', () => {
    const tempDirPath = createTempDir();
    const ghqRootPath = path.join(tempDirPath, 'ghq');
    const activeRepoPath = createRepository(path.join(ghqRootPath, 'github.com', 'owner', 'active'));
    const unusedRepoPath = createRepository(path.join(ghqRootPath, 'github.com', 'owner', 'unused'));

    git(activeRepoPath, 'worktree', 'add', '-q', '-b', 'feature', '.tmp/branch-worktree');
    git(activeRepoPath, 'worktree', 'add', '-q', '--detach', '.tmp/detached-worktree');
    git(path.join(activeRepoPath, '.tmp', 'detached-worktree'), 'commit', '-q', '--allow-empty', '-m', 'detached');
    writeFile(path.join(activeRepoPath, '.tmp', 'stale', 'log.txt'));
    writeFile(path.join(activeRepoPath, '.tmp', 'tracked', 'keep.txt'));
    git(activeRepoPath, 'add', '-f', '.tmp/tracked/keep.txt');
    git(activeRepoPath, 'commit', '-q', '-m', 'track a .tmp file');
    writeFile(path.join(activeRepoPath, 'node_modules', 'pkg', 'index.js'));
    writeFile(path.join(unusedRepoPath, 'node_modules', 'pkg', 'index.js'));
    writeFile(path.join(unusedRepoPath, 'native', 'target', 'CACHEDIR.TAG'));
    setOld(tempDirPath, 60);
    writeFile(path.join(activeRepoPath, '.tmp', 'recent', 'log.txt'));
    for (const fileName of ['index', 'HEAD']) setNow(path.join(activeRepoPath, '.git', fileName));

    const result = runWbGc({ GHQ_ROOT: ghqRootPath, HOME: tempDirPath });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(activeRepoPath, '.tmp', 'stale'))).toBe(false);
    expect(fs.existsSync(path.join(activeRepoPath, '.tmp', 'branch-worktree'))).toBe(false);
    expect(git(activeRepoPath, 'worktree', 'list')).not.toContain('branch-worktree');
    expect(git(activeRepoPath, 'branch', '--list', 'feature')).toContain('feature');
    expect(fs.existsSync(path.join(activeRepoPath, '.tmp', 'detached-worktree'))).toBe(true);
    expect(fs.existsSync(path.join(activeRepoPath, '.tmp', 'tracked', 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(activeRepoPath, '.tmp', 'recent'))).toBe(true);
    expect(fs.existsSync(path.join(activeRepoPath, 'node_modules'))).toBe(true);
    expect(fs.existsSync(path.join(unusedRepoPath, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(unusedRepoPath, 'native', 'target'))).toBe(false);
    expect(fs.existsSync(path.join(unusedRepoPath, 'native'))).toBe(true);
  }, 60_000);

  it('removes stale workspaces of other jobs on a self-hosted CI runner once per interval', () => {
    const tempDirPath = createTempDir();
    const workRootPath = path.join(tempDirPath, '_work');
    const currentWorkspacePath = path.join(workRootPath, 'current');
    createRepository(path.join(currentWorkspacePath, 'current'));
    createRepository(path.join(workRootPath, 'stale', 'stale'));
    createRepository(path.join(workRootPath, 'recent', 'recent'));
    writeFile(path.join(workRootPath, '_tool', 'node', 'bin'));
    setOld(tempDirPath, 10);
    setNow(path.join(workRootPath, 'recent', 'recent', '.git', 'FETCH_HEAD'));
    const env = {
      CI: 'true',
      HOME: tempDirPath,
      RUNNER_ENVIRONMENT: 'self-hosted',
      RUNNER_WORKSPACE: currentWorkspacePath,
    };

    const result = runWb(['kill-port-if-non-ci'], env);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(workRootPath, 'stale'))).toBe(false);
    expect(fs.existsSync(currentWorkspacePath)).toBe(true);
    expect(fs.existsSync(path.join(workRootPath, 'recent'))).toBe(true);
    expect(fs.existsSync(path.join(workRootPath, '_tool'))).toBe(true);

    createRepository(path.join(workRootPath, 'another', 'another'));
    setOld(path.join(workRootPath, 'another'), 10);
    expect(runWb(['kill-port-if-non-ci'], env).status).toBe(0);
    expect(fs.existsSync(path.join(workRootPath, 'another'))).toBe(true);
  }, 60_000);
});

function runWbGc(env: Record<string, string>): childProcess.SpawnSyncReturns<string> {
  return runWb(['gc'], { CI: '', ...env });
}

function runWb(args: string[], env: Record<string, string>): childProcess.SpawnSyncReturns<string> {
  const miseDirPath = path.join(env.HOME ?? '', 'mise');
  const result = childProcess.spawnSync('bun', ['src/index.ts', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WB_GC_CHECKED: '',
      MISE_CACHE_DIR: path.join(miseDirPath, 'cache'),
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
  return childProcess.execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
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

function setNow(targetPath: string): void {
  fs.utimesSync(targetPath, new Date(), new Date());
}
