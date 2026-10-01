import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll } from 'bun:test';
import { removeNpmAndYarnEnvironmentVariables } from '@willbooster/shared-lib-node/src';

import { clearProjectCaches } from '../../src/project.js';

/**
 * Creates a fixture directory that the calling test file removes in `afterAll`, so concurrent test
 * files never copy fixtures over each other's directories, and restores `process.env` as it was when
 * the file started, which `initializeProjectDirectory` changes. Call it at the test file's top level:
 * the hook attaches to the scope being collected, and the test files that one process runs share this
 * module, so a hook registered here at import time would run after the first importing file only.
 */
export function createTempDir(): string {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
  const originalEnv = { ...process.env };
  afterAll(() => {
    fs.rmSync(dirPath, { force: true, recursive: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });
  return dirPath;
}

export async function initializeProjectDirectory(dirPath: string): Promise<void> {
  // The process-global Project caches would otherwise serve instances built from a previous
  // test's fixture content for the same path.
  clearProjectCaches();
  await fs.promises.rm(dirPath, { recursive: true, force: true });
  await fs.promises.cp(path.join('test', 'fixtures', path.basename(dirPath)), dirPath, {
    force: true,
    recursive: true,
  });
  removeNpmAndYarnEnvironmentVariables(process.env);
}
