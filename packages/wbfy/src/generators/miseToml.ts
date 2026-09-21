import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import semver from 'semver';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { spawnSyncAndReturnStdout } from '../utils/spawnUtil.js';

interface MiseToml {
  tools?: Record<string, unknown>;
}

// The oldest Bun runtime wbfy supports.
export const minimumBunVersion = '1.4.0';

/**
 * Pins Node.js and the latest Bun and (when fnox.toml exists) fnox versions. Only the changed pin
 * lines are edited in place: re-serializing the parsed TOML would drop every comment and collapse
 * multi-line strings (e.g. mise task scripts) in the rest of the file.
 */
export async function generateMiseToml(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateMiseToml', async () => {
    const miseTomlPath = path.resolve(config.dirPath, 'mise.toml');
    const content = readMiseToml(miseTomlPath);
    // A parse failure must abort: editing pins in a broken mise.toml would hide the breakage.
    const tools = (Bun.TOML.parse(content) as MiseToml).tools ?? {};

    const pins: Record<string, unknown> = {
      // Ensure Node.js is always pinned: generated hooks and CI run `mise install`, and an unpinned
      // Node would come from whatever happens to be on PATH.
      // Lift-then-pin: the lift only touches exact pins and the pin only touches selectors, so
      // ordering the lift first avoids resolving `mise latest node@lts` twice for unpinned repos.
      node: pinConcreteToolVersion(
        'node',
        liftOutdatedToolVersionWithinMajor('node@lts', tools.node, config.dirPath),
        config.dirPath
      ),
      bun: pinLatestToolVersion('bun', tools.bun, config.dirPath),
    };
    if (fs.existsSync(path.resolve(config.dirPath, 'fnox.toml'))) {
      pins.fnox = pinLatestToolVersion('fnox', tools.fnox, config.dirPath);
    }

    let newContent = content;
    for (const [tool, version] of Object.entries(pins)) {
      if (version === tools[tool]) continue;
      assert.ok(typeof version === 'string', `The resolved ${tool} pin must be a version string.`);
      newContent = setToolVersion(newContent, tool, version);
      // A line edit breaks pins written in any other form (a multi-line value, a `tools.bun`
      // dotted key, a `[tools.bun]` sub-table), so never write a result the parser disagrees with.
      assert.ok(
        parseTools(newContent)?.[tool] === version,
        `Write the ${tool} pin in mise.toml as one \`${tool} = ...\` line under [tools].`
      );
    }
    await fsUtil.generateFile(miseTomlPath, newContent);
  });
}

function setToolVersion(content: string, tool: string, version: string): string {
  const pin = `${tool} = "${version}"`;
  const section = /^\[tools\](?:\n(?!\[).*)*/mu.exec(content)?.[0];
  if (section === undefined) return `${content && `${content.trimEnd()}\n\n`}[tools]\n${pin}\n`;

  const pinPattern = new RegExp(`^${tool} = .*?(\\s+#.*)?$`, 'mu');
  // Blank lines and comments that end the section lead the next table, so a new pin goes above them.
  const pinsEnd = /(?:\n[\t ]*(?:#.*)?)*$/u.exec(section)?.index ?? section.length;
  const newSection = pinPattern.test(section)
    ? section.replace(pinPattern, `${pin}$1`)
    : `${section.slice(0, pinsEnd)}\n${pin}${section.slice(pinsEnd)}`;
  return content.replace(section, () => newSection);
}

function parseTools(content: string): Record<string, unknown> | undefined {
  try {
    return (Bun.TOML.parse(content) as MiseToml).tools;
  } catch {
    return undefined;
  }
}

/** Updates to the latest release across major versions without downgrading existing exact pins. */
function pinLatestToolVersion(tool: string, version: unknown, cwd: string): unknown {
  // Resolve independently of the target's trust state and tool aliases.
  const resolvedVersion = spawnSyncAndReturnStdout('mise', ['--no-config', 'latest', tool], cwd);
  if (!semver.valid(resolvedVersion)) return version ?? 'latest';
  // A cached release listing can lag behind another machine that already updated the pin.
  return typeof version === 'string' && semver.valid(version) && semver.gt(version, resolvedVersion)
    ? version
    : resolvedVersion;
}

/**
 * Lifts an exact tool pin below the latest resolvable version — within the SAME major — to that
 * version (Node.js resolves against the latest LTS): the repository-structure standard tracks the
 * current toolchain across repositories and Renovate does not manage mise.toml pins, so
 * patch/minor drift (e.g. node 24.16.0 vs 24.18.0) never self-heals. A pin
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

function readMiseToml(miseTomlPath: string): string {
  try {
    return fs.readFileSync(miseTomlPath, 'utf8');
  } catch (error) {
    // Only a repository without mise.toml starts from an empty configuration; an unreadable file
    // (e.g. permissions) must abort instead of being overwritten with generated settings.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
