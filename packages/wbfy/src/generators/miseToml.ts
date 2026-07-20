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
    // A migration source that exists but is refused by the confined read (a symlink or a path
    // resolving outside the repository) must abort generation: proceeding as if it were absent
    // would silently replace its pins (e.g. a linked .node-version) with freshly resolved versions.
    for (const sourceName of ['.tool-versions', '.node-version']) {
      const sourcePath = path.resolve(config.dirPath, sourceName);
      const sourceStats = await fs.promises.lstat(sourcePath).catch(() => {});
      if (sourceStats && (await fsUtil.readFileConfinedIfExists(sourcePath)) === undefined) {
        console.warn(`Skipped generating ${miseTomlPath} because ${sourcePath} exists but cannot be read safely.`);
        return;
      }
    }
    // A parse failure must abort instead of falling back to {}: regenerating from an empty object
    // would silently replace the user's existing (albeit broken) mise.toml.
    const settings = parseMiseToml(miseTomlPath);
    const toolVersions = await readToolVersions(config.dirPath);
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
    // Lift-then-pin: the lift only touches exact pins and the pin only touches selectors, so
    // ordering the lift first avoids resolving `mise latest node@lts` twice for unpinned repos.
    tools.node = pinConcreteToolVersion(
      'node',
      liftOutdatedToolVersionWithinMajor(
        'node@lts',
        tools.node ?? (await readNodeVersionFile(config.dirPath)),
        config.dirPath
      ),
      config.dirPath
    );
    tools.bun = liftOutdatedBunVersion(tools.bun ?? 'latest', currentBunVersion);
    if (fs.existsSync(path.resolve(config.dirPath, 'fnox.toml'))) {
      tools.fnox = pinConcreteToolVersion(
        'fnox',
        liftOutdatedToolVersionWithinMajor('fnox', tools.fnox, config.dirPath),
        config.dirPath
      );
    }
    settings.tools = tools;

    // Delete the migration source only after the replacement actually landed; a refused write
    // (e.g. a symlinked mise.toml) must not destroy the only tool configuration.
    if (await fsUtil.generateFile(miseTomlPath, stringify(settings))) {
      const toolVersionsPath = path.resolve(config.dirPath, '.tool-versions');
      // The source-refusal guard at the top guarantees that an existing .tool-versions was
      // safely read and migrated, so removing it (for a symlink: the link entry only) is safe —
      // keeping it would leave an active duplicate configuration source that mise still reads.
      if (await fs.promises.lstat(toolVersionsPath).catch(() => {})) {
        await promisePool.run(() => fsUtil.removeConfined(toolVersionsPath));
      }
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
 * Lifts an exact tool pin below the latest resolvable version — within the SAME major — to that
 * version (Node.js resolves against the latest LTS): the repository-structure standard tracks the
 * current toolchain across repositories and Renovate does not manage mise.toml pins, so
 * patch/minor drift (e.g. node 24.16.0 vs 24.18.0, fnox 1.30.0 vs 1.31.0) never self-heals. A pin
 * on an older major is a deliberate compatibility choice and is kept, as are non-exact and
 * non-string forms. When mise cannot resolve the selector (e.g. offline), the pin is kept.
 */
function liftOutdatedToolVersionWithinMajor(selector: string, version: unknown, cwd: string): unknown {
  if (typeof version !== 'string' || !semver.valid(version)) return version;
  const latestVersion = spawnSyncAndReturnStdout('mise', ['latest', selector], cwd);
  return semver.valid(latestVersion) &&
    semver.major(latestVersion) === semver.major(version) &&
    semver.lt(version, latestVersion)
    ? latestVersion
    : version;
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

async function readNodeVersionFile(dirPath: string): Promise<string | undefined> {
  // Confined read: a committed .node-version symlink pointing outside the repository must not
  // contribute an external file's content to the generated mise.toml.
  const content = await fsUtil.readFileConfinedIfExists(path.resolve(dirPath, '.node-version'));
  const version = content?.trim().replace(/^v/u, '');
  return version || undefined;
}

async function readToolVersions(dirPath: string): Promise<Map<string, string[]>> {
  const versions = new Map<string, string[]>();
  // Confined read: a committed .tool-versions symlink pointing outside the repository must not
  // get its target's content migrated into the tracked mise.toml (and the link deleted).
  const content = await fsUtil.readFileConfinedIfExists(path.resolve(dirPath, '.tool-versions'));
  for (const line of content?.split('\n') ?? []) {
    const [tool, ...toolVersions] = line.replace(/#.*$/u, '').trim().split(/\s+/u);
    if (tool && toolVersions.length > 0) {
      versions.set(tool, toolVersions);
    }
  }
  return versions;
}
