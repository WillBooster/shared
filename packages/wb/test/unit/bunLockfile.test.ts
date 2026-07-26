import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeBunLockfile } from '../../src/utils/bunLockfile.js';

describe('normalizeBunLockfile', () => {
  it('empties every Takumi Guard resolved URL and leaves other registries alone', async () => {
    await withTempDir(async (dirPath) => {
      const lockfilePath = path.join(dirPath, 'bun.lock');
      await fs.writeFile(
        lockfilePath,
        `{
  "packages": {
    "chalk": ["chalk@5.6.2", "https://npm.flatt.tech/chalk/-/chalk-5.6.2.tgz", {}, "sha512-a"],
    "cosmiconfig": ["cosmiconfig@9.0.0", "", {}, "sha512-b"],
    "@willbooster-private/x": ["@willbooster-private/x@1.0.0", "https://verdaccio-production-e389.up.railway.app/@willbooster-private/x/-/x-1.0.0.tgz", {}, "sha512-c"]
  }
}
`
      );

      expect(normalizeBunLockfile(dirPath)).toBe(true);
      const content = await fs.readFile(lockfilePath, 'utf8');
      expect(content).not.toContain('npm.flatt.tech');
      expect(content).toContain('["chalk@5.6.2", "", {}, "sha512-a"]');
      // A scoped private registry legitimately records its own URL.
      expect(content).toContain('https://verdaccio-production-e389.up.railway.app/');

      // Idempotent: a clean lockfile is left byte-for-byte alone.
      expect(normalizeBunLockfile(dirPath)).toBe(false);
      expect(await fs.readFile(lockfilePath, 'utf8')).toBe(content);
    });
  });

  it('does nothing without a bun.lock', async () => {
    await withTempDir(async (dirPath) => {
      expect(normalizeBunLockfile(dirPath)).toBe(false);
    });
  });
});

async function withTempDir(runTest: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wb-bun-lockfile-')));
  try {
    await runTest(dirPath);
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
}
