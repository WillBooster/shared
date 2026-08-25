import fs from 'node:fs';
import path from 'node:path';

import semver from 'semver';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { spawnSyncAndReturnStdout } from '../utils/spawnUtil.js';

interface MiseToml {
  tools?: Record<string, unknown>;
  [key: string]: unknown;
}

// The oldest Bun runtime wbfy supports.
export const minimumBunVersion = '1.4.0';

/**
 * Ensures mise.toml manages the Node.js, Bun and (when fnox.toml exists) fnox tool versions while
 * preserving unrelated mise settings.
 */
export async function generateMiseToml(config: PackageConfig, currentBunVersion: string): Promise<void> {
  return logger.functionIgnoringException('generateMiseToml', async () => {
    const miseTomlPath = path.resolve(config.dirPath, 'mise.toml');
    // A parse failure must abort instead of falling back to {}: regenerating from an empty object
    // would silently replace the user's existing (albeit broken) mise.toml.
    const settings = parseMiseToml(miseTomlPath);
    const tools = { ...settings.tools };

    // Ensure Node.js and Bun are always pinned: generated hooks and CI run `mise install`, and an
    // unpinned Node would come from whatever happens to be on PATH.
    // Lift-then-pin: the lift only touches exact pins and the pin only touches selectors, so
    // ordering the lift first avoids resolving `mise latest node@lts` twice for unpinned repos.
    tools.node = pinConcreteToolVersion(
      'node',
      liftOutdatedToolVersionWithinMajor('node@lts', tools.node, config.dirPath),
      config.dirPath
    );
    // A repository without a Bun pin (e.g. a fresh template) takes the Bun version running wbfy,
    // which the startup guard already proved meets the floor, so generation never depends on mise
    // resolving `latest`.
    const bunVersion = pinSupportedBunVersion(tools.bun ?? currentBunVersion, config.dirPath);
    if (!bunVersion) {
      console.warn(`Skipped generating ${miseTomlPath} because Bun must be pinned to one exact version >= 1.4.`);
      return;
    }
    tools.bun = bunVersion;
    if (fs.existsSync(path.resolve(config.dirPath, 'fnox.toml'))) {
      tools.fnox = pinConcreteToolVersion(
        'fnox',
        liftOutdatedToolVersionWithinMajor('fnox', tools.fnox, config.dirPath),
        config.dirPath
      );
    }
    settings.tools = tools;

    // @ts-expect-error -- Bun 1.4 provides TOML.stringify before the age-gated @types/bun version declares it.
    await fsUtil.generateFile(miseTomlPath, Bun.TOML.stringify(settings));
  });
}

function pinSupportedBunVersion(version: unknown, cwd: string): string | undefined {
  const pinnedVersion = pinConcreteToolVersion('bun', version, cwd);
  if (
    typeof pinnedVersion !== 'string' ||
    !semver.valid(pinnedVersion) ||
    semver.lt(pinnedVersion, minimumBunVersion)
  ) {
    return;
  }
  return pinnedVersion;
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
  // them: `prefix:24` is rejected outright while `24` resolves, and `lts/*` yields empty output
  // while `lts` resolves. Modifier selectors such as `sub-2:lts` stay unresolvable and fall back
  // to the original selector below.
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
  return Bun.TOML.parse(content) as MiseToml;
}
