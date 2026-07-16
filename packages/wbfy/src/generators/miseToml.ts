import fs from 'node:fs';
import path from 'node:path';

import semver from 'semver';
import { parse, stringify } from 'smol-toml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

interface MiseToml {
  tools?: Record<string, unknown>;
  [key: string]: unknown;
}

// The oldest Bun that understands every option in the generated bunfig.toml (globalStore).
export const minimumBunVersion = '1.3.14';

/**
 * Ensures mise.toml manages the Node.js, Bun and (when fnox.toml exists) fnox tool versions,
 * migrating versions from a legacy .tool-versions file and preserving unrelated mise settings.
 */
export async function generateMiseToml(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateMiseToml', async () => {
    const miseTomlPath = path.resolve(config.dirPath, 'mise.toml');
    // A parse failure must abort instead of falling back to {}: regenerating from an empty object
    // would silently replace the user's existing (albeit broken) mise.toml.
    const settings = parseMiseToml(miseTomlPath);
    const toolVersions = readToolVersions(config.dirPath);
    const tools = { ...settings.tools };

    // Migrate every .tool-versions entry, not just Node.js and Bun: mise reads asdf tool names,
    // so dropping e.g. python or ruby pins would silently unpin those tools.
    for (const [tool, versions] of toolVersions) {
      // asdf calls the Node.js plugin "nodejs"; mise's canonical name is "node".
      const miseTool = tool === 'nodejs' ? 'node' : tool;
      tools[miseTool] = tools[miseTool] ?? (versions.length > 1 ? versions : versions[0]);
    }
    // Ensure Node.js and Bun are always pinned: generated hooks and CI run `mise install`, and an
    // unpinned Node would come from whatever happens to be on PATH.
    tools.node = tools.node ?? readNodeVersionFile(config.dirPath) ?? 'latest';
    tools.bun = liftOutdatedBunVersion(tools.bun ?? 'latest');
    if (fs.existsSync(path.resolve(config.dirPath, 'fnox.toml'))) {
      tools.fnox = tools.fnox ?? 'latest';
    }
    settings.tools = tools;

    await fsUtil.generateFile(miseTomlPath, stringify(settings));
    await promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.tool-versions'), { force: true }));
  });
}

/**
 * The generated bunfig.toml relies on `globalStore` (Bun >= 1.3.14) and `publicHoistPattern`
 * (Bun >= 1.3.1); older Bun versions silently ignore them and install a different layout from the
 * one wbfy validated, so lift any pin that cannot resolve to the minimum. Handles mise's string,
 * array, and `{ version = "…" }` tool forms; prefix pins like "1.2" are ranges, so a pin is lifted
 * only when its whole range is below the minimum.
 */
function liftOutdatedBunVersion(bunVersion: unknown): unknown {
  if (typeof bunVersion === 'string') {
    return isVersionRangeBelow(bunVersion, minimumBunVersion) ? 'latest' : bunVersion;
  }
  if (Array.isArray(bunVersion)) {
    return [
      ...new Set(
        bunVersion.map((version) => (typeof version === 'string' ? liftOutdatedBunVersion(version) : version))
      ),
    ];
  }
  if (bunVersion && typeof bunVersion === 'object' && 'version' in bunVersion) {
    return { ...bunVersion, version: liftOutdatedBunVersion(bunVersion.version) };
  }
  return bunVersion;
}

function isVersionRangeBelow(versionRange: string, minimumVersion: string): boolean {
  // Non-semver specifiers such as "latest" yield no range and are left untouched.
  return !!semver.validRange(versionRange) && semver.gtr(minimumVersion, versionRange);
}

function parseMiseToml(miseTomlPath: string): MiseToml {
  let content: string;
  try {
    content = fs.readFileSync(miseTomlPath, 'utf8');
  } catch {
    // A repository without mise.toml starts from an empty configuration.
    return {};
  }
  return parse(content) as MiseToml;
}

function readNodeVersionFile(dirPath: string): string | undefined {
  try {
    const version = fs.readFileSync(path.resolve(dirPath, '.node-version'), 'utf8').trim().replace(/^v/u, '');
    return version || undefined;
  } catch {
    return undefined;
  }
}

function readToolVersions(dirPath: string): Map<string, string[]> {
  const versions = new Map<string, string[]>();
  try {
    const content = fs.readFileSync(path.resolve(dirPath, '.tool-versions'), 'utf8');
    for (const line of content.split('\n')) {
      const [tool, ...toolVersions] = line.replace(/#.*$/u, '').trim().split(/\s+/u);
      if (tool && toolVersions.length > 0) {
        versions.set(tool, toolVersions);
      }
    }
  } catch {
    // A repository without .tool-versions has nothing to migrate.
  }
  return versions;
}
