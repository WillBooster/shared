import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';

export async function installAgentSkills(rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('installAgentSkills', async () => {
    // TODO: We are temporarily removing agent skills from the repo
    // await runInstallAgentSkills(rootConfig);
    await Promise.all([
      fs.rm(path.resolve(rootConfig.dirPath, '.agents'), {
        force: true,
        recursive: true,
      }),
      fs.rm(path.resolve(rootConfig.dirPath, '.claude'), {
        force: true,
        recursive: true,
      }),
      fs.rm(path.resolve(rootConfig.dirPath, 'skills-lock.json'), {
        force: true,
      }),
    ]);
  });
}
