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
 * (identical) gate and exclusion list. The generated settings assume up-to-date package managers
 * (Bun >= 1.3, Yarn >= 4.12, npm >= 11.17) — the org policy is to upgrade, not to accommodate
 * older versions.
 *
 * These files live outside every repository, so writes deliberately bypass fsUtil's
 * repository-containment guards and go through plain fs instead.
 */
export async function ensureGlobalReleaseAgeGates(): Promise<void> {
  return logger.functionIgnoringException('ensureGlobalReleaseAgeGates', async () => {
    const homeDirPath = os.homedir();
    // Bun reads EITHER location, not both: when XDG_CONFIG_HOME is set, get_home_config_path in
    // oven-sh/bun src/bunfig/arguments.rs returns $XDG_CONFIG_HOME/.bunfig.toml without ever
    // consulting $HOME, so the XDG file must be created even when absent. ~/.bunfig.toml is still
    // written so the gate survives the variable being unset later.
    const bunfigPaths = [
      ...(process.env.XDG_CONFIG_HOME ? [path.join(process.env.XDG_CONFIG_HOME, '.bunfig.toml')] : []),
      path.join(homeDirPath, '.bunfig.toml'),
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
        await writeFileAtomically(filePath, newContent);
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
  // `install` may be any TOML value (a hand-written `install = "…"` scalar parses fine), so it
  // must be narrowed before the `in` checks below.
  const install = (parsed as { install?: unknown } | undefined)?.install;
  // A gate the developer wrote outside the managed block would collide with the managed keys
  // (TOML rejects duplicate keys). Fail safe: leave the file alone and tell them to remove it —
  // silently rewriting hand-written lines in a personal file risks destroying unrelated content.
  if (
    install &&
    typeof install === 'object' &&
    ('minimumReleaseAge' in install || 'minimumReleaseAgeExcludes' in install)
  ) {
    console.warn(
      'Skipped updating the global bunfig.toml: it already sets minimumReleaseAge(Excludes) outside the wbfy-managed block. Remove them to let wbfy manage the gate.'
    );
    return undefined;
  }

  const managedBlock = `${startMarker}
minimumReleaseAge = ${bunMinimumReleaseAgeSeconds} # ${minimumReleaseAgeDays} days
minimumReleaseAgeExcludes = [
${bunMinimumReleaseAgeExcludes.map((packageName) => `    "${packageName}",`).join('\n')}
]
${endMarker}`;
  // The [install] header stays OUTSIDE the managed markers: TOML table scope continues past the
  // block, so a developer appending their own install key after it writes into [install] — a
  // header inside the block would take that key with it (reparenting it to top level) when the
  // next run strips the block. Reuse the developer's own header when present because TOML forbids
  // a second [install] header.
  const installHeaderPattern = /^[ \t]*\[install][ \t]*(?:#.*)?$/m;
  const headerMatch = installHeaderPattern.exec(rest);
  let content: string;
  if (headerMatch) {
    const insertAt = headerMatch.index + headerMatch[0].length;
    content = `${rest.slice(0, insertAt)}\n${managedBlock}${rest.slice(insertAt)}`;
  } else {
    content = appendBlock(rest, `[install]\n${managedBlock}\n`);
  }
  // Also catches exotic-but-valid declarations the header regex cannot place keys into (dotted
  // `install.x = …` or a quoted `["install"]` header): the appended second [install] table makes
  // this reparse fail, so such files are skipped with a warning instead of being corrupted.
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

  // Minutes as a plain number: Yarn's home-rc scalars all parse as strings (FAILSAFE_SCHEMA) and
  // miscUtils.parseDuration passes a unit-less value through in the setting's unit (minutes), so a
  // bare number is unambiguous, while duration strings were misparsed by the pre-DURATION versions
  // of the setting (day suffixes went through parseInt; see yarnpkg/berry#6942).
  const content = appendBlock(
    rest,
    `${startMarker}
npmMinimalAgeGate: ${minimumReleaseAgeMinutes} # ${minimumReleaseAgeDays} days
npmPreapprovedPackages:
${bunMinimumReleaseAgeExcludes.map((packageName) => `  - '${packageName}'`).join('\n')}
${endMarker}
`
  );
  // Appending a mapping is invalid after non-mapping YAML (a scalar or sequence document, or a
  // `...` document-end marker) even though Yarn itself accepts such files; corrupting the file
  // would break every subsequent yarn command, so skip instead.
  try {
    loadYaml(content);
  } catch {
    console.warn('Skipped updating the global .yarnrc.yml because the merged result is not valid YAML.');
    return undefined;
  }
  return content;
}

/** Returns the updated ~/.npmrc content, or undefined when the file must be left as-is. */
export function newGlobalNpmrcContent(existingContent: string | undefined): string | undefined {
  const rest = removeManagedBlock(existingContent);
  // npmrc is a plain ini of independent lines (often holding credentials), so only a conflicting
  // gate line blocks the update; everything else is preserved verbatim.
  if (rest.split('\n').some((line) => /^\s*min-release-age(-exclude)?\s*(\[\s*])?\s*=/.test(line))) {
    console.warn(
      'Skipped updating the global .npmrc: it already sets min-release-age(-exclude) outside the wbfy-managed block. Remove it to let wbfy manage the gate.'
    );
    return undefined;
  }

  return appendBlock(
    rest,
    `${startMarker}
min-release-age=${minimumReleaseAgeDays}
${bunMinimumReleaseAgeExcludes.map((packageName) => `min-release-age-exclude[]=${packageName}`).join('\n')}
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

/**
 * These files hold credentials and personal settings, and fs.writeFile truncates before its
 * (possibly multiple) writes — a crash or full disk mid-write would destroy content the update was
 * required to preserve. Write a sibling temp file and rename it into place instead. Symlinked
 * dotfiles are replaced at their resolved target so the symlink itself survives.
 */
async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  const targetFilePath = await resolveWriteTarget(filePath);
  await fs.promises.mkdir(path.dirname(targetFilePath), { recursive: true });
  const stats = await fs.promises.stat(targetFilePath).catch(() => {});
  // Unique name + exclusive create: a stale temp file from an interrupted or concurrent run must
  // never be reused — writeFile applies `mode` only on creation, so reusing one would hand its
  // (possibly looser) permissions to a credential-bearing target on rename.
  const tempFilePath = `${targetFilePath}.${process.pid}.wbfy-tmp`;
  try {
    await fs.promises.writeFile(tempFilePath, content, { flag: 'wx', mode: stats ? stats.mode : undefined });
    // writeFile's mode is masked by the umask; restore the target's exact mode (e.g. 0600 .npmrc).
    if (stats) await fs.promises.chmod(tempFilePath, stats.mode);
    await fs.promises.rename(tempFilePath, targetFilePath);
  } catch (error) {
    await fs.promises.rm(tempFilePath, { force: true });
    throw error;
  }
}

/**
 * Resolves the path the content must land at, following symlinks so a dotfiles link keeps pointing
 * at its repository. realpath alone is not enough: it fails on a DANGLING link (target not created
 * yet), whose link must also survive — so walk lstat/readlink manually.
 */
async function resolveWriteTarget(filePath: string): Promise<string> {
  let currentPath = filePath;
  for (let i = 0; i < 8; i++) {
    const stats = await fs.promises.lstat(currentPath).catch(() => {});
    if (!stats || !stats.isSymbolicLink()) return currentPath;
    currentPath = path.resolve(path.dirname(currentPath), await fs.promises.readlink(currentPath));
  }
  // A chain this deep is a cycle; renaming onto it would silently replace one of its links.
  throw new Error(`Too many levels of symbolic links: ${filePath}`);
}
