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
 * Cargo honors the key from 1.100; 1.98 and 1.99 warn that they ignore it, and older versions ignore
 * it silently, so writing it never breaks an older toolchain.
 */
export async function generateCargoConfigToml(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateCargoConfigToml', async () => {
    const { filePath, content } = await gateCargoConfig(path.resolve(config.dirPath, '.cargo'));
    await promisePool.runAndWaitForReturnValue(() => fsUtil.generateFile(filePath, content));
  });
}

/**
 * Returns the config file Cargo reads in `cargoDirPath` (the legacy `config`, which Cargo prefers when
 * both exist, else `config.toml`) and its content with the gate set, keeping every other setting.
 * The policy is the organization's, never the repository's or the user's: a hand-weakened value is
 * overwritten. Throws when the gate cannot be written as one line under the `[registry]` header.
 */
export async function gateCargoConfig(cargoDirPath: string): Promise<{ filePath: string; content: string }> {
  const legacyFilePath = path.join(cargoDirPath, 'config');
  const legacyContent = await fsUtil.readFileIfExists(legacyFilePath);
  const filePath = legacyContent === undefined ? path.join(cargoDirPath, 'config.toml') : legacyFilePath;
  const content = legacyContent ?? (await fsUtil.readFileIfExists(filePath)) ?? '';
  return {
    filePath,
    content: setTomlTableString(content, 'registry', 'global-min-publish-age', `${releaseAgeGate.days} days`),
  };
}
