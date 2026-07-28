import { describe, expect, it } from 'vitest';

import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  hasFnoxConfigForRepository,
  repositoryUsesEnvCascade,
  selectManagedWbVersion,
} from '../../src/generators/packageJson.js';

// wb >= 19 loads environment variables only from fnox, so wbfy must not materialize such a
// version for repositories that still rely on the .env cascade without a root fnox.toml (fresh
// installs, `*`, and upgrades all flow through this selection). Repositories using neither fnox
// nor .env files have nothing to migrate and get the latest wb.
describe('selectManagedWbVersion', () => {
  it('keeps the latest version for repositories not needing the fnox migration', () => {
    expect(
      selectManagedWbVersion(
        false,
        '19.0.0',
        () => {
          throw new Error('must not be called');
        },
        '/repo'
      )
    ).toBe('19.0.0');
  });

  it('caps a fnox-only latest version to the latest pre-fnox-only release for repositories needing the migration', () => {
    expect(selectManagedWbVersion(true, '19.1.0', () => '18.0.1', '/repo')).toBe('18.0.1');
  });

  it('caps a fnox-only PRE-release version for repositories needing the migration', () => {
    expect(selectManagedWbVersion(true, '19.0.0-alpha.0', () => '18.0.1', '/repo')).toBe('18.0.1');
  });

  it('keeps a pre-fnox-only latest version for repositories needing the migration', () => {
    expect(
      selectManagedWbVersion(
        true,
        '18.0.1',
        () => {
          throw new Error('must not be called');
        },
        '/repo'
      )
    ).toBe('18.0.1');
  });

  it('falls back to the last known pre-fnox-only release when the lookup fails', () => {
    expect(selectManagedWbVersion(true, '19.0.0', () => {}, '/repo')).toBe('18.0.1');
  });

  it('resolves a failed-lookup marker to a compatible release for repositories needing the migration', () => {
    expect(selectManagedWbVersion(true, '*', () => '18.0.1', '/repo')).toBe('18.0.1');
    expect(selectManagedWbVersion(true, '*', () => {}, '/repo')).toBe('18.0.1');
  });

  it('passes through a failed-lookup marker for repositories not needing the migration', () => {
    expect(
      selectManagedWbVersion(
        false,
        '*',
        () => {
          throw new Error('must not be called');
        },
        '/repo'
      )
    ).toBe('*');
  });
});

describe('hasFnoxConfigForRepository', () => {
  it('finds an ancestor fnox.toml within the git repository and ignores one outside it', () => {
    const outerPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-fnox-repo-'));
    try {
      fs.writeFileSync(path.join(outerPath, 'fnox.toml'), '');
      const repoPath = path.join(outerPath, 'repo');
      const childPath = path.join(repoPath, 'packages', 'app');
      fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
      fs.mkdirSync(childPath, { recursive: true });
      // The outer fnox.toml lies beyond the .git boundary, so the repository counts as non-fnox.
      expect(hasFnoxConfigForRepository(childPath)).toBe(false);
      fs.writeFileSync(path.join(repoPath, 'fnox.toml'), '');
      expect(hasFnoxConfigForRepository(childPath)).toBe(true);
      expect(hasFnoxConfigForRepository(repoPath)).toBe(true);
    } finally {
      fs.rmSync(outerPath, { recursive: true, force: true });
    }
  });
});

function createGitRepository(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-env-repo-'));
  child_process.execFileSync('git', ['init', '--quiet'], { cwd: repoPath });
  return repoPath;
}

describe('repositoryUsesEnvCascade', () => {
  it('detects nothing in a repository without cascade files or DOT_ENV workflows', () => {
    const repoPath = createGitRepository();
    try {
      fs.writeFileSync(path.join(repoPath, 'package.json'), '{}');
      const workflowsPath = path.join(repoPath, '.github', 'workflows');
      fs.mkdirSync(workflowsPath, { recursive: true });
      fs.writeFileSync(path.join(workflowsPath, 'test.yml'), 'jobs: {}\n');
      expect(repositoryUsesEnvCascade(repoPath)).toBe(false);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('detects a tracked cascade file', () => {
    const repoPath = createGitRepository();
    try {
      fs.writeFileSync(path.join(repoPath, '.env.production'), 'FOO=1\n');
      child_process.execFileSync('git', ['add', '.env.production'], { cwd: repoPath });
      expect(repositoryUsesEnvCascade(repoPath)).toBe(true);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('detects an untracked cascade file and memoizes the verdict across its deletion', () => {
    const repoPath = createGitRepository();
    try {
      fs.writeFileSync(path.join(repoPath, '.env.example'), 'FOO=\n');
      expect(repositoryUsesEnvCascade(repoPath)).toBe(true);
      // The memoized verdict must survive removeEnvExample deleting the file mid-run (index.ts
      // primes the memo before that fixer).
      fs.rmSync(path.join(repoPath, '.env.example'));
      expect(repositoryUsesEnvCascade(repoPath)).toBe(true);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('detects a gitignored cascade file, also from a workspace child', () => {
    const repoPath = createGitRepository();
    try {
      // Gitignored nested .env.local: a developer-local configuration source.
      fs.writeFileSync(path.join(repoPath, '.gitignore'), '.env.local\n');
      const childPath = path.join(repoPath, 'packages', 'app');
      fs.mkdirSync(childPath, { recursive: true });
      fs.writeFileSync(path.join(childPath, '.env.local'), 'FOO=1\n');
      expect(repositoryUsesEnvCascade(repoPath)).toBe(true);
      // Scanning starts from the repository root even when invoked on a workspace child.
      expect(repositoryUsesEnvCascade(childPath)).toBe(true);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('ignores the .env.cloudflare sidecar and files inside wholly ignored directories', () => {
    const repoPath = createGitRepository();
    try {
      fs.writeFileSync(path.join(repoPath, '.env.cloudflare'), 'CLOUDFLARE_API_TOKEN=x\n');
      fs.writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules/\n');
      const dependencyPath = path.join(repoPath, 'node_modules', 'some-pkg');
      fs.mkdirSync(dependencyPath, { recursive: true });
      fs.writeFileSync(path.join(dependencyPath, '.env'), 'FOO=1\n');
      expect(repositoryUsesEnvCascade(repoPath)).toBe(false);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('fails closed when git cannot run in the repository', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-env-broken-repo-'));
    try {
      // A stale worktree-style gitdir link makes every git command fail; an empty listing must
      // not read as "no cascade files", so detection assumes the cascade is in use.
      fs.writeFileSync(path.join(repoPath, '.git'), 'gitdir: /nonexistent/gitdir\n');
      expect(repositoryUsesEnvCascade(repoPath)).toBe(true);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('detects a .env.cloudflare.local variant (only the exact sidecar name is excluded)', () => {
    const repoPath = createGitRepository();
    try {
      // wb 18's `--cascade-env=cloudflare` loads `.env.cloudflare.local`; only the exact
      // `.env.cloudflare` sidecar is read by wb regardless of fnox.
      fs.writeFileSync(path.join(repoPath, '.env.cloudflare.local'), 'FOO=1\n');
      expect(repositoryUsesEnvCascade(repoPath)).toBe(true);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('detects a legacy DOT_ENV secret wired into a workflow', () => {
    const repoPath = createGitRepository();
    try {
      const workflowsPath = path.join(repoPath, '.github', 'workflows');
      fs.mkdirSync(workflowsPath, { recursive: true });
      fs.writeFileSync(
        path.join(workflowsPath, 'test.yml'),
        'jobs:\n  test:\n    secrets:\n      DOT_ENV: ${{ secrets.DOT_ENV }}\n'
      );
      expect(repositoryUsesEnvCascade(repoPath)).toBe(true);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
