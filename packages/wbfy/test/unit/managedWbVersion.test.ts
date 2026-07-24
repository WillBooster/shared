import { describe, expect, it } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hasFnoxConfigForRepository, selectManagedWbVersion } from '../../src/generators/packageJson.js';

// wb >= 19 loads environment variables only from fnox, so wbfy must not materialize such a
// version for repositories without a root fnox.toml (fresh installs, `*`, and upgrades all flow
// through this selection).
describe('selectManagedWbVersion', () => {
  it('keeps the latest version for fnox repositories', () => {
    expect(
      selectManagedWbVersion(
        true,
        '19.0.0',
        () => {
          throw new Error('must not be called');
        },
        '/repo'
      )
    ).toBe('19.0.0');
  });

  it('caps a fnox-only latest version to the latest pre-fnox-only release for non-fnox repositories', () => {
    expect(selectManagedWbVersion(false, '19.1.0', () => '18.0.1', '/repo')).toBe('18.0.1');
  });

  it('caps a fnox-only PRE-release version for non-fnox repositories', () => {
    expect(selectManagedWbVersion(false, '19.0.0-alpha.0', () => '18.0.1', '/repo')).toBe('18.0.1');
  });

  it('keeps a pre-fnox-only latest version for non-fnox repositories', () => {
    expect(
      selectManagedWbVersion(
        false,
        '18.0.1',
        () => {
          throw new Error('must not be called');
        },
        '/repo'
      )
    ).toBe('18.0.1');
  });

  it('falls back to the last known pre-fnox-only release when the lookup fails', () => {
    expect(selectManagedWbVersion(false, '19.0.0', () => {}, '/repo')).toBe('18.0.1');
  });

  it('resolves a failed-lookup marker to a compatible release for non-fnox repositories', () => {
    expect(selectManagedWbVersion(false, '*', () => '18.0.1', '/repo')).toBe('18.0.1');
    expect(selectManagedWbVersion(false, '*', () => {}, '/repo')).toBe('18.0.1');
  });

  it('passes through a failed-lookup marker for fnox repositories', () => {
    expect(
      selectManagedWbVersion(
        true,
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
