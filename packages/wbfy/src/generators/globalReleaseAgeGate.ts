import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dump as dumpYaml, FAILSAFE_SCHEMA, loadAll as loadAllYaml } from 'js-yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { logger } from '../logger.js';

import { bunMinimumReleaseAgeExcludes, bunMinimumReleaseAgeSeconds } from './bunfig.js';

// Repository bunfig.toml files receive the same 7-day gate; keep every package manager's global
// value derived from the single Bun constant so the org policy cannot drift per manager.
const minimumReleaseAgeDays = bunMinimumReleaseAgeSeconds / 86_400;
const minimumReleaseAgeMinutes = bunMinimumReleaseAgeSeconds / 60;

// Legacy files from the marker-based format: parse + stringify drops the markers from TOML/YAML
// automatically (they are comments), but the line-based .npmrc needs explicit removal.
const legacyMarkerLinePattern = /^[ \t]*# wbfy:(?:start|end) release-age-gate[ \t]*\n?/gm;
const npmrcGateLinePattern = /^[ \t]*min-release-age(?:-exclude)?\s*(?:\[\s*])?\s*=[^\n]*\n?/gm;

const npmrcGateLines = `min-release-age=${minimumReleaseAgeDays}
${bunMinimumReleaseAgeExcludes.map((packageName) => `min-release-age-exclude[]=${packageName}`).join('\n')}
`;

/**
 * Applies the organization's minimum-release-age policy to the developer machine's GLOBAL
 * package-manager configs (~/.bunfig.toml, ~/.yarnrc.yml, ~/.npmrc). Repository configs guard only
 * wbfied repositories; a brand-new local project has no bunfig.toml yet, so the global files are
 * the only gate between `bun create` / `npm init` and a freshly compromised release. Project-level
 * configuration takes precedence in all three managers, so wbfied repositories keep their own
 * (identical) gate and exclusion list.
 *
 * Operational rules (org policy: company machines leave no room for personal configuration):
 * - ~/.bunfig.toml and ~/.yarnrc.yml are machine-generated and machine-managed: every run
 *   re-canonicalizes them via parse + stringify, so comments, formatting, and layout are never
 *   preserved, and a file that does not parse into a top-level table/mapping is replaced
 *   wholesale with a warning; allowing unexpected content is a bigger risk than discarding it.
 *   Settings other than the gate keys survive as parsed data (e.g. registry credentials).
 * - ~/.npmrc stays line-based: the gate lines are managed and every other line (credentials,
 *   comments) is preserved verbatim.
 * - Only filesystem errors (e.g. permissions) skip a file. These files live outside every
 *   repository, so writes bypass fsUtil's repository-containment guards.
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

/** Returns the canonical ~/.bunfig.toml content with the managed gate enforced. */
export function newGlobalBunfigContent(existingContent: string | undefined): string {
  // Bun accepts a UTF-8 BOM but smol-toml rejects it; strip it so an otherwise valid file is not
  // replaced. Beyond that, smol-toml's spec-strict TOML 1.0 is the reference syntax by org
  // decision: Bun-only leniencies (a bare `@scope` key under [install.scopes], duplicate table
  // headers) take the wholesale-replacement path, and quoting the scope key is the manual fix.
  const config = parseTableSafely('.bunfig.toml', () => parseToml((existingContent ?? '').replace(/^\uFEFF/, '')));
  const install = asTable(config.install);
  install.minimumReleaseAge = bunMinimumReleaseAgeSeconds;
  install.minimumReleaseAgeExcludes = [...bunMinimumReleaseAgeExcludes];
  config.install = install;
  const content = stringifyToml(config);
  return content.endsWith('\n') ? content : `${content}\n`;
}

/** Returns the canonical ~/.yarnrc.yml content with the managed gate enforced. */
export function newGlobalYarnrcContent(existingContent: string | undefined): string {
  // Parse like Yarn itself: parseSyml uses load(source, {schema: FAILSAFE_SCHEMA, json: true})
  // (yarnpkg/berry packages/yarnpkg-parsers/sources/syml.ts). All scalars stay strings — the
  // default schema would corrupt digit-only credentials (0-prefix loss, float rounding) and turn
  // date-shaped values into Date objects — and duplicate keys overwrite instead of throwing, so a
  // file Yarn accepts is never mistaken for unparseable and wiped. Yarn coerces typed settings
  // from strings, so the quoting that dump adds to such scalars is behavior-neutral.
  // loadAll instead of load: js-yaml v5's load throws "expected a document" on an absent, empty,
  // or comment-only file, which Yarn treats as an empty config — a no-document parse must reach
  // the empty-table path, not the unparseable-replacement warning.
  const config = parseTableSafely('.yarnrc.yml', () => {
    const documents = loadAllYaml(existingContent ?? '', { schema: FAILSAFE_SCHEMA, json: true });
    return documents.length === 1 ? documents[0] : documents.length === 0 ? undefined : documents;
  });
  // Minutes as a plain number: Yarn's home-rc scalars all parse as strings (FAILSAFE_SCHEMA) and
  // miscUtils.parseDuration passes a unit-less value through in the setting's unit (minutes), so a
  // bare number is unambiguous, while duration strings were misparsed by the pre-DURATION versions
  // of the setting (day suffixes went through parseInt; see yarnpkg/berry#6942).
  config.npmMinimalAgeGate = minimumReleaseAgeMinutes;
  config.npmPreapprovedPackages = [...bunMinimumReleaseAgeExcludes];
  // FAILSAFE parsing maps an empty value (`key:`) to the empty string, which dumps as `key: ''`
  // and round-trips stably, so no value in the table can be null and no null handling is needed.
  return dumpYaml(config);
}

/** Returns the ~/.npmrc content with the managed gate enforced. */
export function newGlobalNpmrcContent(existingContent: string | undefined): string {
  // npmrc is a plain ini of independent lines (often holding credentials), so the non-gate lines
  // are already canonical enough and are preserved verbatim.
  const rest = (existingContent ?? '')
    .replaceAll('\r\n', '\n')
    .replaceAll(legacyMarkerLinePattern, '')
    .replaceAll(npmrcGateLinePattern, '')
    .replace(/\n+$/, '');
  return rest ? `${rest}\n${npmrcGateLines}` : npmrcGateLines;
}

/** Returns the parsed top-level table, or an empty one when the file cannot serve as a base. */
function parseTableSafely(fileLabel: string, parse: () => unknown): Record<string, unknown> {
  try {
    const parsed = parse();
    // A contentless file (absent, blank, or comment-only) parses to undefined/null and maps to an
    // empty config, exactly like Yarn's parseViaJsYaml, so it deserves no replacement warning.
    if (parsed === undefined || parsed === null) return {};
    const table = asTable(parsed);
    if (table !== parsed) {
      console.warn(`Replacing the global ${fileLabel} wholesale because it is not a top-level table.`);
    }
    return table;
  } catch {
    // Deliberately omit the parser error: js-yaml/smol-toml messages embed source snippets of the
    // broken file, which may hold credentials that must not reach terminal captures or CI logs.
    console.warn(`Replacing the unparseable global ${fileLabel} wholesale with the org-managed content.`);
    return {};
  }
}

// Only a PLAIN object counts as a table: the parsers can hand back typed non-table objects — e.g.
// a TOML datetime value (a Date subclass) or an array of tables reaching this via
// `config.install` — and assigning gate keys onto those would be silently dropped by stringify.
function asTable(value: unknown): Record<string, unknown> {
  const proto = value !== null && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  return proto === Object.prototype || proto === null ? (value as Record<string, unknown>) : {};
}
