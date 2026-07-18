import fs from 'node:fs';
import path from 'node:path';

import semver from 'semver';
import { parse, stringify } from 'smol-toml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { spawnSyncAndReturnStdout } from '../utils/spawnUtil.js';

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
    tools.node = liftOutdatedNodeVersion(
      pinConcreteToolVersion('node', tools.node ?? readNodeVersionFile(config.dirPath), config.dirPath),
      config.dirPath
    );
    tools.bun = liftOutdatedBunVersion(tools.bun ?? 'latest', currentBunVersion);
    if (fs.existsSync(path.resolve(config.dirPath, 'fnox.toml'))) {
      tools.fnox = pinConcreteToolVersion('fnox', tools.fnox, config.dirPath);
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

/**
 * Lifts an exact Node.js pin below the latest LTS — within the SAME major — to the latest LTS:
 * the repository-structure standard tracks the current LTS across repositories and Renovate does
 * not manage mise.toml pins, so patch/minor drift (e.g. 24.16.0 vs 24.18.0) never self-heals. A
 * pin on an older major is a deliberate compatibility choice and is kept, as are non-exact and
 * non-string forms. When mise cannot resolve the LTS (e.g. offline), the pin is kept.
 */
function liftOutdatedNodeVersion(nodeVersion: unknown, cwd: string): unknown {
  if (typeof nodeVersion !== 'string' || !semver.valid(nodeVersion)) return nodeVersion;
  const latestLts = spawnSyncAndReturnStdout('mise', ['latest', 'node@lts'], cwd);
  return semver.valid(latestLts) &&
    semver.major(latestLts) === semver.major(nodeVersion) &&
    semver.lt(nodeVersion, latestLts)
    ? latestLts
    : nodeVersion;
}

/**
 * Replaces an unpinned selector (`latest`, a range such as "24", an alias, or a missing entry)
 * with the newest concrete version mise resolves for it, because the repository-structure
 * standard requires concrete pins: CI installs whatever an unpinned selector resolves to at run
 * time, so builds drift across runs. Exact versions are kept as-is, and non-string forms (mise's
 * array and `{ version = "…" }` forms) are user-managed and left untouched. When mise is
 * unavailable or cannot resolve the selector (e.g. offline), the original selector is kept —
 * an unpinned tool is better than a broken configuration.
 */
function pinConcreteToolVersion(tool: string, version: unknown, cwd: string): unknown {
  if (version !== undefined && (typeof version !== 'string' || semver.valid(version))) return version;
  // Normalize selector forms `mise latest` cannot resolve even though mise configuration accepts
  // them: `prefix:24` is rejected outright while `24` resolves, and `lts/*` (idiomatic in
  // .node-version files) yields empty output while `lts` resolves. Modifier selectors such as
  // `sub-2:lts` stay unresolvable and fall back to the original selector below.
  const range = typeof version === 'string' ? version.replace(/^prefix:/u, '').replace(/\/\*$/u, '') : undefined;
  // With no meaningful selector, Node.js pins to the latest LTS (matching the reusable workflows'
  // `lts/*` fallback) rather than the newest release.
  const defaultSelector = tool === 'node' ? 'node@lts' : tool;
  const selector = range && range !== 'latest' ? `${tool}@${range}` : defaultSelector;
  const resolvedVersion = spawnSyncAndReturnStdout('mise', ['latest', selector], cwd);
  return semver.valid(resolvedVersion) ? resolvedVersion : (version ?? 'latest');
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
  } catch (error) {
    // An unreadable file must abort instead of being ignored; the file is a migration source.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function readToolVersions(dirPath: string): Map<string, string[]> {
  const versions = new Map<string, string[]>();
  let content: string | undefined;
  try {
    content = fs.readFileSync(path.resolve(dirPath, '.tool-versions'), 'utf8');
  } catch (error) {
    // Only a repository without .tool-versions has nothing to migrate; an unreadable file must
    // abort instead of being silently discarded (it is deleted after mise.toml is written).
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const line of content?.split('\n') ?? []) {
    const [tool, ...toolVersions] = line.replace(/#.*$/u, '').trim().split(/\s+/u);
    if (tool && toolVersions.length > 0) {
      versions.set(tool, toolVersions);
    }
  }
  return versions;
}
