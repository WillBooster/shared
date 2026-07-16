import fs from 'node:fs';
import path from 'node:path';

import { parse, stringify } from 'smol-toml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

interface MiseToml {
  tools?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Ensures mise.toml manages the Node.js, Bun and (when fnox.toml exists) fnox tool versions,
 * migrating versions from a legacy .tool-versions file and preserving unrelated mise settings.
 */
export async function generateMiseToml(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateMiseToml', async () => {
    const miseTomlPath = path.resolve(config.dirPath, 'mise.toml');
    const settings = parseMiseToml(miseTomlPath);
    const toolVersions = readToolVersions(config.dirPath);
    const tools = { ...settings.tools };

    const nodeVersion = tools.node ?? toolVersions.get('nodejs') ?? toolVersions.get('node');
    if (nodeVersion !== undefined) {
      tools.node = nodeVersion;
    }
    tools.bun = tools.bun ?? toolVersions.get('bun') ?? 'latest';
    if (fs.existsSync(path.resolve(config.dirPath, 'fnox.toml'))) {
      tools.fnox = tools.fnox ?? 'latest';
    }
    settings.tools = tools;

    await fsUtil.generateFile(miseTomlPath, stringify(settings));
    await promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.tool-versions'), { force: true }));
  });
}

function parseMiseToml(miseTomlPath: string): MiseToml {
  try {
    return parse(fs.readFileSync(miseTomlPath, 'utf8')) as MiseToml;
  } catch {
    return {};
  }
}

function readToolVersions(dirPath: string): Map<string, string> {
  const versions = new Map<string, string>();
  try {
    const content = fs.readFileSync(path.resolve(dirPath, '.tool-versions'), 'utf8');
    for (const line of content.split('\n')) {
      const [tool, version] = line.replace(/#.*$/u, '').trim().split(/\s+/u);
      if (tool && version) {
        versions.set(tool, version);
      }
    }
  } catch {
    // A repository without .tool-versions has nothing to migrate.
  }
  return versions;
}
