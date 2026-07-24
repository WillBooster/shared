import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import {
  getMeaningfulDeclaredWorkspacePatterns,
  hasImplicitWorkspaceBaseline,
  resolveBunWorkspacePackageJsonPaths,
} from '../../src/bunWorkspaces.js';

test('evaluates patterns sequentially: a later positive re-adds what an earlier negation removed', () => {
  withPackageDirs(['apps/web', 'apps/excluded'], (rootDirPath) => {
    expect(resolveBunWorkspacePackageJsonPaths(['apps/*', '!apps/excluded'], rootDirPath)).toEqual([
      'apps/web/package.json',
    ]);
    expect(resolveBunWorkspacePackageJsonPaths(['!apps/excluded', 'apps/*'], rootDirPath)).toEqual([
      'apps/excluded/package.json',
      'apps/web/package.json',
    ]);
  });
});

test('a non-glob positive pattern pins its directory regardless of negation order (issue #1008)', () => {
  withPackageDirs(['packages/a', 'packages/lib'], (rootDirPath) => {
    for (const workspaces of [
      ['packages/*', 'packages/lib', '!packages/lib'],
      ['packages/*', '!packages/lib', 'packages/lib'],
      ['packages/lib', '!packages/lib'],
    ]) {
      expect(resolveBunWorkspacePackageJsonPaths(workspaces, rootDirPath), workspaces.join(',')).toContain(
        'packages/lib/package.json'
      );
    }
  });
});

test('a two-segment star-run negation seeds the implicit baseline before deleting its matches', () => {
  withPackageDirs(['apps/web', 'other/x', 'deep/nested/pkg'], (rootDirPath) => {
    // `!other/*` seeds `*/*` (depth 2 only), then removes other/x.
    expect(resolveBunWorkspacePackageJsonPaths(['!other/*'], rootDirPath)).toEqual(['apps/web/package.json']);
    // `!other/**` seeds `**` (any depth), then removes other/x.
    expect(resolveBunWorkspacePackageJsonPaths(['!other/**'], rootDirPath)).toEqual([
      'apps/web/package.json',
      'deep/nested/pkg/package.json',
    ]);
    // Seeding also happens alongside positive patterns.
    expect(resolveBunWorkspacePackageJsonPaths(['deep/nested/pkg', '!other/*'], rootDirPath)).toEqual([
      'apps/web/package.json',
      'deep/nested/pkg/package.json',
    ]);
    // Non-seeding negation shapes link nothing on their own.
    for (const workspaces of [['!*'], ['!**'], ['!*/*'], ['!apps/excluded'], ['!apps/*d'], ['!a/b/*']]) {
      expect(resolveBunWorkspacePackageJsonPaths(workspaces, rootDirPath), workspaces.join(',')).toEqual([]);
    }
  });
});

test('`**` matches zero segments but never turns the monorepo root into a workspace', () => {
  withPackageDirs(['apps'], (rootDirPath) => {
    expect(resolveBunWorkspacePackageJsonPaths(['apps/**'], rootDirPath)).toEqual(['apps/package.json']);
    expect(resolveBunWorkspacePackageJsonPaths(['**'], rootDirPath)).toEqual(['apps/package.json']);
  });
});

test('drops no-op patterns, applies bang parity, and ignores repository-escaping patterns', () => {
  expect(getMeaningfulDeclaredWorkspacePatterns(['', '!', '.', './', 'apps/*', '!!a', '!!!b'])).toEqual([
    'apps/*',
    'a',
    '!b',
  ]);
  expect(getMeaningfulDeclaredWorkspacePatterns({ packages: ['packages/*'] })).toEqual(['packages/*']);
  expect(getMeaningfulDeclaredWorkspacePatterns(undefined)).toEqual([]);
  withPackageDirs(['apps/web'], (rootDirPath) => {
    expect(resolveBunWorkspacePackageJsonPaths(['/abs/*', '../outside/*', 'apps/*'], rootDirPath)).toEqual([
      'apps/web/package.json',
    ]);
  });
});

test('matches lone-`?` segments like Bun despite fast-glob returning no file matches for them', () => {
  withPackageDirs(['packages/a', 'packages/b', 'packages/long'], (rootDirPath) => {
    // Bun 1.3.14 links packages/a and packages/b for `packages/?`; fast-glob 3.3.3 returns [] for
    // the file glob `packages/?/package.json`, so the resolver complements it with a directory
    // glob.
    expect(resolveBunWorkspacePackageJsonPaths(['packages/?'], rootDirPath)).toEqual([
      'packages/a/package.json',
      'packages/b/package.json',
    ]);
  });
});

test('links dot-directory packages only through fully static patterns, like Bun', () => {
  withPackageDirs(['.hidden/x', 'packages/a'], (rootDirPath) => {
    // Bun 1.3.14 links nothing under .hidden for these dynamic patterns, even with a literal
    // dotted segment, but pins the fully static `.hidden/x`.
    expect(resolveBunWorkspacePackageJsonPaths(['.hidden/*'], rootDirPath)).toEqual([]);
    expect(resolveBunWorkspacePackageJsonPaths(['.*/*'], rootDirPath)).toEqual([]);
    expect(resolveBunWorkspacePackageJsonPaths(['**'], rootDirPath)).toEqual(['packages/a/package.json']);
    expect(resolveBunWorkspacePackageJsonPaths(['.hidden/x'], rootDirPath)).toEqual(['.hidden/x/package.json']);
  });
});

test('keeps a workspace directory whose name merely starts with ".." inside the repository', () => {
  withPackageDirs(['..pkg'], (rootDirPath) => {
    expect(resolveBunWorkspacePackageJsonPaths(['..pkg'], rootDirPath)).toEqual(['..pkg/package.json']);
  });
});

test('drops a workspace whose symlink escapes the repository but keeps internal symlinks', () => {
  const outerDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-workspaces-symlink-'));
  try {
    const rootDirPath = path.join(outerDirPath, 'repo');
    fs.mkdirSync(path.join(rootDirPath, 'real-pkg'), { recursive: true });
    fs.mkdirSync(path.join(outerDirPath, 'outside'));
    fs.writeFileSync(path.join(rootDirPath, 'package.json'), JSON.stringify({ name: 'root' }));
    fs.writeFileSync(path.join(rootDirPath, 'real-pkg', 'package.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(outerDirPath, 'outside', 'package.json'), JSON.stringify({}));
    // Bun links both, but the resolver must keep only the internal one: consumers (node_modules
    // cleanup, manifest rewriting) would otherwise operate on another repository via the symlink.
    fs.symlinkSync(path.join('..', 'outside'), path.join(rootDirPath, 'escaping'));
    fs.symlinkSync('real-pkg', path.join(rootDirPath, 'internal'));
    expect(resolveBunWorkspacePackageJsonPaths(['escaping', 'internal', 'real-pkg'], rootDirPath)).toEqual([
      'internal/package.json',
      'real-pkg/package.json',
    ]);
  } finally {
    fs.rmSync(outerDirPath, { recursive: true, force: true });
  }
});

test('detects the implicit workspace baseline only for seeding negation shapes', () => {
  expect(hasImplicitWorkspaceBaseline(['!other/*'])).toBe(true);
  expect(hasImplicitWorkspaceBaseline(['apps/*', '!other/**'])).toBe(true);
  expect(hasImplicitWorkspaceBaseline(['!other/***'])).toBe(true);
  expect(hasImplicitWorkspaceBaseline(['apps/*'])).toBe(false);
  expect(hasImplicitWorkspaceBaseline(['!*'])).toBe(false);
  expect(hasImplicitWorkspaceBaseline(['!**/*'])).toBe(false);
  expect(hasImplicitWorkspaceBaseline(['!apps/excluded'])).toBe(false);
  expect(hasImplicitWorkspaceBaseline(['!'])).toBe(false);
  expect(hasImplicitWorkspaceBaseline(undefined)).toBe(false);
});

/** Creates a temp monorepo whose given directories each contain a package.json. */
function withPackageDirs(packageDirPaths: string[], testBody: (rootDirPath: string) => void): void {
  const rootDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-workspaces-'));
  try {
    fs.writeFileSync(path.join(rootDirPath, 'package.json'), JSON.stringify({ name: 'root' }));
    for (const packageDirPath of packageDirPaths) {
      fs.mkdirSync(path.join(rootDirPath, packageDirPath), { recursive: true });
      fs.writeFileSync(path.join(rootDirPath, packageDirPath, 'package.json'), JSON.stringify({}));
    }
    testBody(rootDirPath);
  } finally {
    fs.rmSync(rootDirPath, { recursive: true, force: true });
  }
}
