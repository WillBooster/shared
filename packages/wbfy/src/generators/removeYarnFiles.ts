import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { promisePool } from '../utils/promisePool.js';

/**
 * wbfy assumes every managed repository uses Bun, so Yarn artifacts are always removed.
 */
export async function removeYarnFiles(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('removeYarnFiles', async () => {
    // yarn.lock is deliberately kept while no Bun lockfile exists yet: `bun install` migrates a
    // yarn.lock into bun.lock only when bun.lock is absent, preserving the resolved dependency
    // versions. It is removed in index.ts right after the Bun lockfile has been refreshed.
    const fileNames = ['.yarnrc', '.yarnrc.yml', '.yarn'];
    if (
      fs.existsSync(path.resolve(config.dirPath, 'bun.lock')) ||
      fs.existsSync(path.resolve(config.dirPath, 'bun.lockb'))
    ) {
      fileNames.push('yarn.lock');
    }
    for (const fileName of fileNames) {
      await promisePool.run(() =>
        fs.promises.rm(path.resolve(config.dirPath, fileName), { force: true, recursive: true })
      );
    }
    const entries = await fs.promises.readdir(config.dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith('.pnp.')) continue;
      await promisePool.run(() =>
        fs.promises.rm(path.resolve(config.dirPath, entry.name), { force: true, recursive: true })
      );
    }
  });
}
