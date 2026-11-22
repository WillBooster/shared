import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';

/**
 * Removes the crate publish-age gate that earlier wbfy versions wrote to the repository's root `.cargo/`.
 * Cargo has no per-crate exemption, so the gate also held back our own crates and failed Renovate's bumps of
 * them for a week after each release.
 */
export async function generateCargoConfigToml(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateCargoConfigToml', async () => {
    for (const { filePath, content } of await ungateCargoConfigs(path.resolve(config.dirPath, '.cargo'))) {
      await (content ? fsUtil.generateFile(filePath, content) : fsUtil.removeConfined(filePath));
    }
  });
}

/**
 * Returns each Cargo config file in `cargoDirPath` that has the gate and its content without it,
 * empty when nothing else remains.
 */
export async function ungateCargoConfigs(cargoDirPath: string): Promise<{ filePath: string; content: string }[]> {
  const files = await Promise.all(
    ['config', 'config.toml'].map(async (fileName) => {
      const filePath = path.join(cargoDirPath, fileName);
      const content = await fs.readFile(filePath, 'utf8').catch(() => {});
      const ungated = content
        ?.replace(/^global-min-publish-age = .*\n/mu, '')
        .replace(/(?<=^|\n)\n?\[registry\]\n$/u, '');
      return content === ungated || ungated === undefined ? undefined : { filePath, content: ungated };
    })
  );
  return files.filter((file) => file !== undefined);
}
