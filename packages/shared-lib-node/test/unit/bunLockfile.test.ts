import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { normalizeBunLockfile } from '../../src/bunLockfile.js';

test('normalizes the enclosing lockfile without changing legitimate registry or tarball URLs', async () => {
  const rootDirPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bun-lockfile-')));
  try {
    const childDirPath = path.join(rootDirPath, 'apps', 'web');
    const lockfilePath = path.join(rootDirPath, 'bun.lock');
    await fs.mkdir(childDirPath, { recursive: true });
    await fs.writeFile(path.join(rootDirPath, '.git'), '');
    await fs.writeFile(
      lockfilePath,
      `{
  "workspaces": {
    "": {
      "dependencies": {
        "tarball": "https://npm.flatt.tech/direct.tgz"
      }
    }
  },
  "packages": {
    "public": ["public@1.0.0", "https://npm.flatt.tech/public/-/public-1.0.0.tgz", {}],
    "private": ["private@1.0.0", "https://registry.example.com/private/-/private-1.0.0.tgz", {}],
    "tarball": ["tarball@https://npm.flatt.tech/direct.tgz", {}, "sha512-a"]
  }
}
`
    );

    expect(normalizeBunLockfile(childDirPath)).toBe(true);
    const content = await fs.readFile(lockfilePath, 'utf8');
    expect(content).toContain('"public": ["public@1.0.0", "", {}]');
    expect(content).toContain('https://registry.example.com/private/-/private-1.0.0.tgz');
    expect(content).toContain('"tarball": "https://npm.flatt.tech/direct.tgz"');
    expect(content).toContain('"tarball": ["tarball@https://npm.flatt.tech/direct.tgz", {}, "sha512-a"]');
    expect(normalizeBunLockfile(childDirPath)).toBe(false);
  } finally {
    await fs.rm(rootDirPath, { force: true, recursive: true });
  }
});
