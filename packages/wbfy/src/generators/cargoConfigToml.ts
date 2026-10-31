import path from 'node:path';

import releaseAgeGate from '../../configs/releaseAgeGate.json' with { type: 'json' };
import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { setTomlTableString } from '../utils/tomlUtil.js';

/**
 * Applies the organization's minimum-release-age policy to Cargo through `.cargo/config.toml` at the
 * repository root. Cargo reads config files from the current directory upward, not from the
 * manifest's directory, and Renovate runs `cargo update --manifest-path <dir>/Cargo.toml` from the
 * repository root, so a config next to a nested Cargo.toml (e.g. src-tauri/) would not gate it.
 * Cargo honors the key from 1.100 and only warns that it is ignored before that.
 */
export async function generateCargoConfigToml(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateCargoConfigToml', async () => {
    const filePath = path.resolve(config.dirPath, '.cargo', 'config.toml');
    const content = (await fsUtil.readFileIfExists(filePath)) ?? '';
    // Org policy, never repository policy: a hand-weakened value is overwritten on every run.
    const newContent = setTomlTableString(content, 'registry', 'global-min-publish-age', `${releaseAgeGate.days} days`);
    await promisePool.runAndWaitForReturnValue(() => fsUtil.generateFile(filePath, newContent));
  });
}
