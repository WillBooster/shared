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
export async function generateMiseToml(config: PackageConfig, currentBunVersion: string): Promise<void> {
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
    tools.bun = liftOutdatedBunVersion(tools.bun ?? 'latest', currentBunVersion);
    if (fs.existsSync(path.resolve(config.dirPath, 'fnox.toml'))) {
      tools.fnox = tools.fnox ?? 'latest';
    }
    settings.tools = tools;

    // Delete the migration source only after the replacement actually landed; a refused write
    // (e.g. a symlinked mise.toml) must not destroy the only tool configuration.
    if (await fsUtil.generateFile(miseTomlPath, stringify(settings))) {
      await promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.tool-versions'), { force: true }));
    }
  });
}

/**
 * The generated bunfig.toml relies on `globalStore` (Bun >= 1.3.14) and `publicHoistPattern`
 * (Bun >= 1.3.1); older Bun versions silently ignore them and install a different layout from the
 * one wbfy validated. mise resolves `latest` and range selectors such as "1.2" or `prefix:1.2` to
 * the newest locally INSTALLED matching version — not the newest release — so only an exact pin
 * at or above the minimum proves the floor. Selectors that cannot prove it are replaced with the
 * Bun version running wbfy (which the startup guard proved meets the floor) rather than the
 * frozen minimum, so repositories keep tracking the current toolchain — and stay aligned with
 * @types/bun, which wbfy updates to the latest release. Handles mise's string, array, and
 * `{ version = "…" }` tool forms.
 */
function liftOutdatedBunVersion(bunVersion: unknown, currentBunVersion: string): unknown {
  if (typeof bunVersion === 'string') {
    const range = bunVersion.startsWith('prefix:') ? bunVersion.slice('prefix:'.length) : bunVersion;
    // Unverifiable selectors ("latest", "ref:…", "path:…", aliases) cannot prove the floor either.
    const lowestResolvableVersion = semver.validRange(range) && semver.minVersion(range);
    return lowestResolvableVersion && semver.gte(lowestResolvableVersion, minimumBunVersion)
      ? bunVersion
      : currentBunVersion;
  }
  if (Array.isArray(bunVersion)) {
    return [...new Set(bunVersion.map((version) => liftOutdatedBunVersion(version, currentBunVersion)))];
  }
  if (bunVersion && typeof bunVersion === 'object' && 'version' in bunVersion) {
    return { ...bunVersion, version: liftOutdatedBunVersion(bunVersion.version, currentBunVersion) };
  }
  return bunVersion;
}

function parseMiseToml(miseTomlPath: string): MiseToml {
  let content: string;
  try {
    content = fs.readFileSync(miseTomlPath, 'utf8');
  } catch (error) {
    // Only a repository without mise.toml starts from an empty configuration; an unreadable file
    // (e.g. permissions) must abort instead of being overwritten with generated settings.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
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
