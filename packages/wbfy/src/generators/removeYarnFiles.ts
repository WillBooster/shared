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
    // Private-registry configuration and dependency patches have no automatic Bun translation;
    // deleting them would break installs (missing credentials) or silently drop patched behavior.
    let yarnrcYml = '';
    try {
      yarnrcYml = await fs.promises.readFile(path.resolve(config.dirPath, '.yarnrc.yml'), 'utf8');
    } catch {
      // No .yarnrc.yml means there is no Yarn-specific configuration to preserve.
    }
    if (
      /^\s*(?:npmRegistryServer|npmRegistries|npmScopes|npmAuthToken|npmAuthIdent)\s*:/mu.test(yarnrcYml) ||
      fs.existsSync(path.resolve(config.dirPath, '.yarn', 'patches'))
    ) {
      console.error(
        'Skip removing Yarn files: .yarnrc.yml declares registry/auth settings or .yarn/patches exists. ' +
          'Migrate them to Bun manually (bunfig.toml install settings / patchedDependencies), then re-run wbfy.'
      );
      return;
    }

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
