import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { project } from '../src/project.js';

export const tempDir = path.join(os.tmpdir(), 'shared');
console.info('tempDir:', tempDir);

export async function initializeProjectDirectory(): Promise<void> {
  await fs.promises.rm(project.dirPath, { recursive: true, force: true });
  await fs.promises.cp(path.join('test-fixtures', path.basename(project.dirPath)), project.dirPath, {
    force: true,
    recursive: true,
  });
  await fs.promises.cp(path.join('..', '..', '.yarn'), path.join(project.dirPath, '.yarn'), {
    force: true,
    recursive: true,
  });
  await fs.promises.cp(path.join('..', '..', '.yarnrc.yml'), path.join(project.dirPath, '.yarnrc.yml'), {
    force: true,
  });
}
