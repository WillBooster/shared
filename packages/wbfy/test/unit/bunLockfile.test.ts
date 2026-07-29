import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { normalizeBunLockfile } from '../../src/utils/bunLockfile.js';

test('normalizes generated Takumi Guard URLs without changing legitimate registry URLs', async () => {
  const dirPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-bun-lockfile-')));
  try {
    const lockfilePath = path.join(dirPath, 'bun.lock');
    await fs.writeFile(
      lockfilePath,
      `{
  "packages": {
    "public": ["public@1.0.0", "https://npm.flatt.tech/public/-/public-1.0.0.tgz", {}],
    "private": ["private@1.0.0", "https://registry.example.com/private/-/private-1.0.0.tgz", {}],
    "tarball": ["tarball@https://npm.flatt.tech/direct.tgz", "https://npm.flatt.tech/direct.tgz", {}]
  }
}
`
    );

    expect(normalizeBunLockfile(dirPath)).toBe(true);
    const content = await fs.readFile(lockfilePath, 'utf8');
    expect(content).toContain('"public": ["public@1.0.0", "", {}]');
    expect(content).toContain('https://registry.example.com/private/-/private-1.0.0.tgz');
    expect(content).toContain('"tarball@https://npm.flatt.tech/direct.tgz"');
    expect(normalizeBunLockfile(dirPath)).toBe(false);
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});
