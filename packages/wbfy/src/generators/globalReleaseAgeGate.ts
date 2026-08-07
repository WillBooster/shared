import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logger } from '../logger.js';

import { bunMinimumReleaseAgeExcludes, bunMinimumReleaseAgeSeconds } from './bunfig.js';

const startMarker = '# wbfy:start release-age-gate';
const endMarker = '# wbfy:end release-age-gate';

const managedBlockPattern = new RegExp(`[ \\t]*${startMarker}[\\s\\S]*?${endMarker}[ \\t]*\\n?`, 'g');

// Repository bunfig.toml files receive the same 7-day gate; keep every package manager's global
// value derived from the single Bun constant so the org policy cannot drift per manager.
const minimumReleaseAgeDays = bunMinimumReleaseAgeSeconds / 86_400;
const minimumReleaseAgeMinutes = bunMinimumReleaseAgeSeconds / 60;

const bunfigManagedBlock = `${startMarker}
minimumReleaseAge = ${bunMinimumReleaseAgeSeconds} # ${minimumReleaseAgeDays} days
minimumReleaseAgeExcludes = [
${bunMinimumReleaseAgeExcludes.map((packageName) => `    "${packageName}",`).join('\n')}
]
${endMarker}`;

// Minutes as a plain number: Yarn's home-rc scalars all parse as strings (FAILSAFE_SCHEMA) and
// miscUtils.parseDuration passes a unit-less value through in the setting's unit (minutes), so a
// bare number is unambiguous, while duration strings were misparsed by the pre-DURATION versions
// of the setting (day suffixes went through parseInt; see yarnpkg/berry#6942).
const yarnrcManagedBlock = `${startMarker}
npmMinimalAgeGate: ${minimumReleaseAgeMinutes} # ${minimumReleaseAgeDays} days
npmPreapprovedPackages:
${bunMinimumReleaseAgeExcludes.map((packageName) => `  - '${packageName}'`).join('\n')}
${endMarker}
`;

const npmrcManagedBlock = `${startMarker}
min-release-age=${minimumReleaseAgeDays}
${bunMinimumReleaseAgeExcludes.map((packageName) => `min-release-age-exclude[]=${packageName}`).join('\n')}
${endMarker}
`;

// Gate keys hand-written outside the managed block are removed unconditionally so the org policy
// always wins; the removal is done in removeBunfigGateKeys / removeYarnrcGateKeys below because a
// multi-line value must be consumed exactly through its real end (bracket balance for flow values,
// the next top-level key for block sequences) — line regexes cannot do that without leaving orphan
// lines that would corrupt the file.
const npmrcGateKeyPattern = /^[ \t]*min-release-age(?:-exclude)?\s*(?:\[\s*])?\s*=[^\n]*\n?/gm;

/**
 * Applies the organization's minimum-release-age policy to the developer machine's GLOBAL
 * package-manager configs (~/.bunfig.toml, ~/.yarnrc.yml, ~/.npmrc). Repository configs guard only
 * wbfied repositories; a brand-new local project has no bunfig.toml yet, so the global files are
 * the only gate between `bun create` / `npm init` and a freshly compromised release. Project-level
 * configuration takes precedence in all three managers, so wbfied repositories keep their own
 * (identical) gate and exclusion list.
 *
 * Operational rules keep this purely textual with no exception paths:
 * - The gate keys are wbfy-managed everywhere in these files: hand-written gate keys outside the
 *   managed block are removed and replaced on every run.
 * - The files are assumed syntactically valid and in standard form (bunfig declares install
 *   settings under an `[install]` header, yarnrc is a top-level mapping). Deviating or broken
 *   files must be fixed manually; wbfy still writes the block without validating the result.
 * - Only filesystem errors (e.g. permissions) skip a file, because ~/.npmrc may hold credentials
 *   wbfy must never destroy. These files live outside every repository, so writes bypass fsUtil's
 *   repository-containment guards.
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
    const targets: [string, (existingContent: string | undefined) => string][] = [
      ...bunfigPaths.map((filePath): [string, typeof newGlobalBunfigContent] => [filePath, newGlobalBunfigContent]),
      [path.join(homeDirPath, '.yarnrc.yml'), newGlobalYarnrcContent],
      [path.join(homeDirPath, '.npmrc'), newGlobalNpmrcContent],
    ];
    for (const [filePath, computeContent] of targets) {
      try {
        const existingContent = fs.existsSync(filePath) ? await fs.promises.readFile(filePath, 'utf8') : undefined;
        const newContent = computeContent(existingContent);
        if (newContent === existingContent) continue;
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
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

/** Returns the ~/.bunfig.toml content with the managed gate enforced. */
export function newGlobalBunfigContent(existingContent: string | undefined): string {
  const rest = removeBunfigGateKeys(removeManagedBlock(existingContent));
  // The [install] header stays OUTSIDE the managed markers: TOML table scope continues past the
  // block, so a developer appending their own install key after it writes into [install] — a
  // header inside the block would take that key with it (reparenting it to top level) when the
  // next run strips the block. Reuse the existing header when present because TOML forbids a
  // second [install] header.
  const headerMatch = /^[ \t]*\[install][ \t]*(?:#.*)?$/m.exec(rest);
  if (headerMatch) {
    const insertAt = headerMatch.index + headerMatch[0].length;
    return `${rest.slice(0, insertAt)}\n${bunfigManagedBlock}${rest.slice(insertAt)}`;
  }
  return appendBlock(rest, `[install]\n${bunfigManagedBlock}\n`);
}

/** Returns the ~/.yarnrc.yml content with the managed gate enforced. */
export function newGlobalYarnrcContent(existingContent: string | undefined): string {
  return appendBlock(removeYarnrcGateKeys(removeManagedBlock(existingContent)), yarnrcManagedBlock);
}

/** Returns the ~/.npmrc content with the managed gate enforced. */
export function newGlobalNpmrcContent(existingContent: string | undefined): string {
  return appendBlock(removeManagedBlock(existingContent).replaceAll(npmrcGateKeyPattern, ''), npmrcManagedBlock);
}

function removeBunfigGateKeys(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';
    const match = /^[ \t]*(['"]?)minimumReleaseAge(Excludes)?\1\s*=\s*(.*)$/.exec(line);
    if (!match) {
      result.push(line);
      continue;
    }
    const value = match[3] ?? '';
    if (match[2] && value.startsWith('[')) {
      lineIndex = findFlowValueEnd(lines, lineIndex, value);
    }
  }
  return result.join('\n');
}

// Keys are matched at column 0 only, where Yarn's own writer places top-level keys; a uniformly
// indented mapping is out of contract, and matching indented keys would risk consuming a sibling
// key's lines instead.
function removeYarnrcGateKeys(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';
    const match = /^(['"]?)(?:npmMinimalAgeGate|npmPreapprovedPackages)\1\s*:\s*(.*)$/.exec(line);
    if (!match) {
      result.push(line);
      continue;
    }
    const value = match[2] ?? '';
    if (value.startsWith('[') || value.startsWith('{')) {
      lineIndex = findFlowValueEnd(lines, lineIndex, value);
    } else {
      // A block value ends before the next top-level key. Trailing comment and blank lines are
      // given back because they document whatever follows, not the removed key.
      let end = lineIndex + 1;
      while (end < lines.length && /^(?:[ \t#-]|$)/.test(lines[end] ?? '')) end++;
      while (end > lineIndex + 1 && /^[ \t]*(?:#|$)/.test(lines[end - 1] ?? '')) end--;
      lineIndex = end - 1;
    }
  }
  return result.join('\n');
}

/** Returns the index of the line on which the flow value's brackets balance (its last line). */
function findFlowValueEnd(lines: string[], startIndex: number, firstLineValue: string): number {
  let depth = 0;
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex++) {
    depth += bracketDelta(lineIndex === startIndex ? firstLineValue : (lines[lineIndex] ?? ''));
    if (depth <= 0) return lineIndex;
  }
  return lines.length - 1;
}

/** Counts the line's bracket balance, ignoring brackets inside strings and after a `#` comment. */
function bracketDelta(lineText: string): number {
  let delta = 0;
  let quote: string | undefined;
  for (let charIndex = 0; charIndex < lineText.length; charIndex++) {
    const char = lineText.charAt(charIndex);
    if (quote) {
      // Backslash escapes exist only in double-quoted strings; TOML literal strings and YAML
      // single-quoted scalars treat it literally (YAML's doubled '' also closes and reopens the
      // string here, which counts brackets between them as quoted — the correct outcome).
      if (char === '\\' && quote === '"') charIndex++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') break;
    else if (char === '[' || char === '{') delta++;
    else if (char === ']' || char === '}') delta--;
  }
  return delta;
}

function removeManagedBlock(content: string | undefined): string {
  return content?.replaceAll(managedBlockPattern, '') ?? '';
}

function appendBlock(rest: string, block: string): string {
  const trimmedRest = rest.replace(/\n+$/, '');
  return trimmedRest ? `${trimmedRest}\n\n${block}` : block;
}
