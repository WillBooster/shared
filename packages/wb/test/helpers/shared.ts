import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { removeNpmAndYarnEnvironmentVariables } from '@willbooster/shared-lib-node/src';

import { clearProjectCaches } from '../../src/project.js';

export const tempDir = path.join(os.tmpdir(), 'shared');

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
