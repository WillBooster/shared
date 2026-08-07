import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { load as loadYaml } from 'js-yaml';
import { parse as parseToml } from 'smol-toml';

import { logger } from '../logger.js';

import { bunMinimumReleaseAgeExcludes, bunMinimumReleaseAgeSeconds } from './bunfig.js';

const startMarker = '# wbfy:start release-age-gate';
const endMarker = '# wbfy:end release-age-gate';

const managedBlockPattern = new RegExp(`[ \\t]*${startMarker}[\\s\\S]*?${endMarker}[ \\t]*\\n?`, 'g');

// Repository bunfig.toml files receive the same 7-day gate; keep every package manager's global
// value derived from the single Bun constant so the org policy cannot drift per manager.
const minimumReleaseAgeDays = bunMinimumReleaseAgeSeconds / 86_400;
const minimumReleaseAgeMinutes = bunMinimumReleaseAgeSeconds / 60;

/**
 * Applies the organization's minimum-release-age policy to the developer machine's GLOBAL
 * package-manager configs (~/.bunfig.toml, ~/.yarnrc.yml, ~/.npmrc). Repository configs guard only
 * wbfied repositories; a brand-new local project has no bunfig.toml yet, so the global files are
 * the only gate between `bun create` / `npm init` and a freshly compromised release. Project-level
 * configuration takes precedence in all three managers, so wbfied repositories keep their own
 * (identical) gate and exclusion list.
 *
 * These files live outside every repository, so writes deliberately bypass fsUtil's
 * repository-containment guards and go through plain fs instead.
 */
export async function ensureGlobalReleaseAgeGates(): Promise<void> {
  return logger.functionIgnoringException('ensureGlobalReleaseAgeGates', async () => {
    const homeDirPath = os.homedir();
    // Bun reads either location; when both exist their precedence is undocumented, so update both.
    const xdgBunfigPath = process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, '.bunfig.toml');
    const bunfigPaths = [
      path.join(homeDirPath, '.bunfig.toml'),
      ...(xdgBunfigPath && fs.existsSync(xdgBunfigPath) ? [xdgBunfigPath] : []),
    ];
    const targets: [string, (existingContent: string | undefined) => string | undefined][] = [
      ...bunfigPaths.map((filePath): [string, typeof newGlobalBunfigContent] => [filePath, newGlobalBunfigContent]),
      [path.join(homeDirPath, '.yarnrc.yml'), newGlobalYarnrcContent],
      [path.join(homeDirPath, '.npmrc'), newGlobalNpmrcContent],
    ];
    for (const [filePath, computeContent] of targets) {
      try {
        const existingContent = fs.existsSync(filePath) ? await fs.promises.readFile(filePath, 'utf8') : undefined;
        const newContent = computeContent(existingContent);
        if (newContent === undefined || newContent === existingContent) continue;
        await fs.promises.writeFile(filePath, newContent);
        console.info(`Applied the minimum-release-age policy to ${filePath}`);
      } catch (error) {
        // ~/.npmrc may hold credentials and ~/.yarnrc.yml personal settings; a single unreadable or
        // unwritable file must neither destroy the others' update nor abort repository processing.
        console.warn(`Skipped updating ${filePath}:`, (error as Error | undefined)?.message ?? error);
      }
    }
  });
}

/** Returns the updated ~/.bunfig.toml content, or undefined when the file must be left as-is. */
export function newGlobalBunfigContent(existingContent: string | undefined): string | undefined {
  const rest = removeManagedBlock(existingContent);
  const parsed = parseTomlSafely(rest);
  if (rest.trim() && parsed === undefined) {
    console.warn('Skipped updating the global bunfig.toml because it is not valid TOML.');
    return undefined;
  }
  const install = (parsed as { install?: Record<string, unknown> } | undefined)?.install;
  // A gate the developer wrote outside the managed block would collide with the managed keys
  // (TOML rejects duplicate keys). Fail safe: leave the file alone and tell them to remove it —
  // silently rewriting hand-written lines in a personal file risks destroying unrelated content.
  if (install && ('minimumReleaseAge' in install || 'minimumReleaseAgeExcludes' in install)) {
    console.warn(
      'Skipped updating the global bunfig.toml: it already sets minimumReleaseAge(Excludes) outside the wbfy-managed block. Remove them to let wbfy manage the gate.'
    );
    return undefined;
  }

  const managedKeys = `minimumReleaseAge = ${bunMinimumReleaseAgeSeconds} # ${minimumReleaseAgeDays} days
minimumReleaseAgeExcludes = [
${bunMinimumReleaseAgeExcludes.map((packageName) => `    "${packageName}",`).join('\n')}
]`;
  // Keys must live under [install]; reuse the developer's own section when present because TOML
  // forbids a second [install] header.
  const installHeaderPattern = /^[ \t]*\[install][ \t]*(?:#.*)?$/m;
  const headerMatch = installHeaderPattern.exec(rest);
  let content: string;
  if (headerMatch) {
    const insertAt = headerMatch.index + headerMatch[0].length;
    content = `${rest.slice(0, insertAt)}\n${startMarker}\n${managedKeys}\n${endMarker}${rest.slice(insertAt)}`;
  } else {
    content = appendBlock(rest, `${startMarker}\n[install]\n${managedKeys}\n${endMarker}\n`);
  }
  if (parseTomlSafely(content) === undefined) {
    console.warn('Skipped updating the global bunfig.toml because the merged result is not valid TOML.');
    return undefined;
  }
  return content;
}

/** Returns the updated ~/.yarnrc.yml content, or undefined when the file must be left as-is. */
export function newGlobalYarnrcContent(existingContent: string | undefined): string | undefined {
  const rest = removeManagedBlock(existingContent);
  let parsed: unknown;
  try {
    parsed = loadYaml(rest);
  } catch {
    console.warn('Skipped updating the global .yarnrc.yml because it is not valid YAML.');
    return undefined;
  }
  if (parsed && typeof parsed === 'object' && ('npmMinimalAgeGate' in parsed || 'npmPreapprovedPackages' in parsed)) {
    console.warn(
      'Skipped updating the global .yarnrc.yml: it already sets npmMinimalAgeGate or npmPreapprovedPackages outside the wbfy-managed block. Remove them to let wbfy manage the gate.'
    );
    return undefined;
  }

  // Minutes as a plain number: Yarn advertises duration strings ("7d"), but their parser has
  // silently ignored day suffixes (yarnpkg/berry#6899), which would disable the gate entirely.
  return appendBlock(
    rest,
    `${startMarker}
# Requires Yarn >= 4.10; older Yarn versions reject unknown settings, so upgrade instead of removing this.
npmMinimalAgeGate: ${minimumReleaseAgeMinutes} # ${minimumReleaseAgeDays} days
npmPreapprovedPackages:
${bunMinimumReleaseAgeExcludes.map((packageName) => `  - '${packageName}'`).join('\n')}
${endMarker}
`
  );
}

/** Returns the updated ~/.npmrc content, or undefined when the file must be left as-is. */
export function newGlobalNpmrcContent(existingContent: string | undefined): string | undefined {
  const rest = removeManagedBlock(existingContent);
  // npmrc is a plain ini of independent lines (often holding credentials), so only a conflicting
  // gate line blocks the update; everything else is preserved verbatim.
  if (rest.split('\n').some((line) => /^\s*min-release-age\s*=/.test(line))) {
    console.warn(
      'Skipped updating the global .npmrc: it already sets min-release-age outside the wbfy-managed block. Remove it to let wbfy manage the gate.'
    );
    return undefined;
  }

  // npm (>= 11.10.0) has no exclusion setting yet; the organization's own packages are installed
  // through Bun in managed repositories, so the loss is acceptable.
  return appendBlock(
    rest,
    `${startMarker}
min-release-age=${minimumReleaseAgeDays}
${endMarker}
`
  );
}

function removeManagedBlock(content: string | undefined): string {
  return content?.replaceAll(managedBlockPattern, '') ?? '';
}

function appendBlock(rest: string, block: string): string {
  const trimmedRest = rest.replace(/\n+$/, '');
  return trimmedRest ? `${trimmedRest}\n\n${block}` : block;
}

function parseTomlSafely(content: string): unknown {
  try {
    return parseToml(content);
  } catch {
    return undefined;
  }
}
