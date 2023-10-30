import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { removeNpmAndYarnEnvironmentVariables } from '@willbooster/shared-lib-node/src';

export const tempDir = path.join(os.tmpdir(), 'shared');

export async function initializeProjectDirectory(dirPath: string): Promise<void> {
  await fs.promises.rm(dirPath, { recursive: true, force: true });
  await fs.promises.cp(path.join('test-fixtures', path.basename(dirPath)), dirPath, {
    force: true,
    recursive: true,
  });
  await fs.promises.cp(path.join('..', '..', '.yarn'), path.join(dirPath, '.yarn'), {
    force: true,
    recursive: true,
  });
  await fs.promises.cp(path.join('..', '..', '.yarnrc.yml'), path.join(dirPath, '.yarnrc.yml'), {
    force: true,
  });
  removeNpmAndYarnEnvironmentVariables(process.env);
}
