import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll } from 'bun:test';
import { removeNpmAndYarnEnvironmentVariables } from '@willbooster/shared-lib-node/src';

import { clearProjectCaches } from '../../src/project.js';

// Per test file: parallel test workers would otherwise copy fixtures over each other's directories.
export const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
// Registered at import time, so it runs after the importing test file's tests.
afterAll(() => {
  fs.rmSync(tempDir, { force: true, recursive: true });
});

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
