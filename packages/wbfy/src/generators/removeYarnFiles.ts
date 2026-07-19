import fs from 'node:fs';
import path from 'node:path';

import { load as loadYaml } from 'js-yaml';
import type { PackageJson } from 'type-fest';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { promisePool } from '../utils/promisePool.js';
import { getWorkspacePackageJsonPaths } from '../utils/workspaceUtil.js';

// Yarn settings wbfy can safely drop when migrating to Bun: tooling and cosmetics that do not
// change what gets installed, plus the org-standard release-age-gate settings that have a Bun
// translation (npmMinimalAgeGate / npmPreapprovedPackages are reflected into the generated
// bunfig.toml's minimumReleaseAge / minimumReleaseAgeExcludes, and approvedGitRepositories has
// no Bun counterpart because Bun does not restrict git dependencies, so dropping it cannot
// change the install graph — org-level git-dependency policy is instead enforced on every wbfy
// run by assertSafeDependencySources, the trade-off explicitly chosen in #1014). Anything else
// (registries, auth, scopes, packageExtensions,
// patchFolder, proxies, supportedArchitectures, ...) affects dependency resolution or install
// behavior and requires manual migration.
const safeYarnrcSettings = new Set([
  'approvedGitRepositories',
  'checksumBehavior',
  'compressionLevel',
  'defaultSemverRangePrefix',
  'enableColors',
  'enableGlobalCache',
  'enableHyperlinks',
  'enableImmutableInstalls',
  'enableInlineBuilds',
  'enableMessageNames',
  'enableProgressBars',
  'enableTelemetry',
  'enableTimers',
  'httpRetry',
  'httpTimeout',
  'logFilters',
  'nmMode',
  'nodeLinker',
  // npmMinimalAgeGate is handled by isMigratableYarnrcSetting (only parsable values migrate).
  'npmPreapprovedPackages',
  'plugins',
  'preferInteractive',
  'progressBarStyle',
  'yarnPath',
]);

// Yarn parses npmMinimalAgeGate with miscUtils.parseDuration: `<number><ms|s|m|h|d|w>`,
// where a bare number means the setting's declared unit (minutes for npmMinimalAgeGate).
const yarnDurationUnitsInSeconds: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
};

const unparsableYarnrc = Symbol('unparsableYarnrc');

/**
 * Whether the value is a plain (optionally scoped) npm package name. Anything else — globs,
 * versioned descriptors, or names with characters npm forbids — is not a usable
 * minimumReleaseAgeExcludes entry, and the strict character set also guarantees the value can be
 * interpolated into a double-quoted TOML string without escaping.
 */
export function isLiteralNpmPackageName(value: string): boolean {
  // Mirrors validate-npm-package-name (verified 7.0.2): both parts of a SCOPED name may contain
  // any URL-safe character including leading `.`/`_` (e.g. `@_scope/pkg`, `@scope/_private`),
  // while an UNSCOPED name must not start with `.`, `_`, or `-`; legacy uppercase names remain
  // installable and are accepted too. Every accepted character is TOML-safe.
  return /^(?:@[\w.~-]+\/[\w.~-]+|[A-Za-z0-9~][\w.~-]*)$/u.test(value);
}

/**
 * Detects Yarn configuration that has no automatic Bun translation. Must run as a read-only
 * preflight BEFORE any fixer mutates the repository: deleting such configuration (or migrating
 * everything around it) would break installs or silently drop patched dependency behavior.
 * All blockers are reported together so a manual migration needs one pass instead of a
 * fix-one-rerun loop.
 * @return A human-readable reason when the repository needs manual migration, otherwise undefined.
 */
export function findUnmigratableYarnSettings(dirPath: string): string | undefined {
  const reasons: string[] = [];
  const parsedYarnrc = readYarnrcYml(dirPath);
  if (parsedYarnrc === unparsableYarnrc) {
    reasons.push('.yarnrc.yml is unparsable');
  } else if (parsedYarnrc) {
    const unsafeSettings = Object.entries(parsedYarnrc)
      .filter(([key, value]) => !isMigratableYarnrcSetting(key, value))
      .map(([key]) => key);
    if (unsafeSettings.length > 0) {
      reasons.push(`.yarnrc.yml declares behavior-affecting settings [${unsafeSettings.join(', ')}]`);
    }
  }
  if (fs.existsSync(path.resolve(dirPath, '.yarn', 'patches'))) {
    reasons.push('.yarn/patches exists');
  }
  for (const manifestPath of findPatchProtocolManifests(dirPath)) {
    reasons.push(`${manifestPath} uses the patch: protocol`);
  }
  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

/**
 * Workspace manifests can declare `patch:` dependencies too, and the migration later rewrites
 * every workspace manifest, so the preflight must inspect the same manifest set as the main flow.
 * @return The root-relative paths of every manifest using the patch: protocol.
 */
function findPatchProtocolManifests(dirPath: string): string[] {
  const manifestPaths = new Set(['package.json']);
  // The main flow processes EVERY immediate packages/* directory (index.ts), even ones a
  // workspace negation excludes, so the preflight must inspect them all regardless of the
  // declared workspace patterns — enumerated with the same readdir/isDirectory rules as
  // index.ts (real directories only, dot-directories included, symlinks excluded) so the two
  // passes can never disagree on the manifest set.
  let packagesManifestPaths: string[] = [];
  try {
    packagesManifestPaths = fs
      .readdirSync(path.resolve(dirPath, 'packages'), { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => path.posix.join('packages', dirent.name, 'package.json'))
      .filter((manifestPath) => fs.existsSync(path.resolve(dirPath, manifestPath)));
  } catch {
    // No packages/ directory.
  }
  for (const manifestPath of packagesManifestPaths) {
    manifestPaths.add(manifestPath);
  }
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(dirPath, 'package.json'), 'utf8')) as PackageJson;
    for (const packageJsonPath of getWorkspacePackageJsonPaths({
      dirPath,
      packageJson,
      doesContainSubPackageJsons: packagesManifestPaths.length > 0,
    })) {
      manifestPaths.add(packageJsonPath);
    }
  } catch {
    // A missing or unparsable root package.json is reported by getPackageConfig later.
  }
  const offendingPaths: string[] = [];
  for (const manifestPath of manifestPaths) {
    try {
      if (manifestUsesPatchProtocol(fs.readFileSync(path.resolve(dirPath, manifestPath), 'utf8'))) {
        offendingPaths.push(manifestPath);
      }
    } catch {
      // An unreadable workspace manifest cannot prove a patch: dependency.
    }
  }
  // Sorted for a deterministic report (readdir and workspace-resolution orders are not guaranteed).
  return offendingPaths.toSorted();
}

/**
 * Only dependency-specifier fields count: a bare substring check would also match prose such as
 * a description or an echo in a script and needlessly block a migratable repository.
 */
function manifestUsesPatchProtocol(manifestText: string): boolean {
  let manifest: PackageJson & { resolutions?: Record<string, unknown> };
  try {
    manifest = JSON.parse(manifestText) as PackageJson & { resolutions?: Record<string, unknown> };
  } catch {
    // An unparsable manifest cannot be inspected precisely; stay conservative.
    return manifestText.includes('"patch:');
  }
  const sections = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
    manifest.resolutions,
  ];
  return sections.some(
    (section) =>
      section &&
      Object.values(section).some((specifier) => typeof specifier === 'string' && specifier.startsWith('patch:'))
  );
}

function isMigratableYarnrcSetting(key: string, value: unknown): boolean {
  // `enableScripts: false` is dropped deliberately even though Bun's default differs slightly
  // (Bun runs lifecycle scripts of its built-in default allow-list of popular packages): wbfy's
  // ensureTrustedDependencies fully owns trustedDependencies and deliberately restores Bun's
  // default allow-list (the ownership policy chosen in #975), so adopting that org baseline is
  // the intended outcome of the migration (#1014). An explicit `enableScripts: true` has no
  // automatic translation because Bun cannot enable all lifecycle scripts wholesale.
  if (key === 'enableScripts') return value === false;
  // A gate value the translation cannot parse (e.g. Yarn's `${ENV_VAR:-14d}` expansion syntax)
  // would silently fall back to the 5-day org default and could WEAKEN the repository's policy,
  // so only literally parsable durations are migratable. Untranslatable npmPreapprovedPackages
  // entries need no such gate: dropping them is fail-safe (packages become age-gated).
  if (key === 'npmMinimalAgeGate') return parseYarnDurationAsSeconds(value) !== undefined;
  return safeYarnrcSettings.has(key);
}

export interface YarnReleaseAgeSettings {
  /** Undefined when .yarnrc.yml declares no (parsable) npmMinimalAgeGate. */
  minimumReleaseAgeSeconds?: number;
  minimumReleaseAgeExcludes: string[];
}

/**
 * Reads the release-age-gate settings from .yarnrc.yml so the generated bunfig.toml can keep
 * their behavior (minimumReleaseAge / minimumReleaseAgeExcludes). Must run BEFORE removeYarnFiles
 * deletes .yarnrc.yml.
 */
export function readYarnrcReleaseAgeSettings(dirPath: string): YarnReleaseAgeSettings {
  const settings: YarnReleaseAgeSettings = { minimumReleaseAgeExcludes: [] };
  const parsed = readYarnrcYml(dirPath);
  if (!parsed || parsed === unparsableYarnrc) return settings;

  const { npmMinimalAgeGate, npmPreapprovedPackages } = parsed as {
    npmMinimalAgeGate?: unknown;
    npmPreapprovedPackages?: unknown;
  };
  settings.minimumReleaseAgeSeconds = parseYarnDurationAsSeconds(npmMinimalAgeGate);
  if (Array.isArray(npmPreapprovedPackages)) {
    settings.minimumReleaseAgeExcludes = npmPreapprovedPackages.filter(
      // Bun matches minimumReleaseAgeExcludes entries literally as package NAMES, so Yarn glob
      // patterns (e.g. `@willbooster/*`) and package descriptors (e.g. `is-number@npm:7.0.0`)
      // would be dead configuration and are dropped. Dropping is fail-safe (an uncovered package
      // becomes age-gated, which surfaces at install time instead of weakening the gate), and
      // the org-standard globs are already covered literally by bunMinimumReleaseAgeExcludes.
      (entry): entry is string => typeof entry === 'string' && isLiteralNpmPackageName(entry)
    );
  }
  return settings;
}

function parseYarnDurationAsSeconds(value: unknown): number | undefined {
  let seconds: number | undefined;
  if (typeof value === 'number') {
    seconds = value * 60;
  } else if (typeof value === 'string') {
    const match = /^(?<num>\d*\.?\d+)(?<unit>[a-z]*)$/u.exec(value.trim());
    const num = match?.groups?.num;
    if (num === undefined) return undefined;
    const multiplier = match?.groups?.unit ? yarnDurationUnitsInSeconds[match.groups.unit] : 60;
    if (multiplier === undefined) return undefined;
    seconds = Number.parseFloat(num) * multiplier;
  }
  // Yarn accepts only non-negative decimal durations, and YAML can still smuggle in negative or
  // non-finite numbers, which Bun's minimumReleaseAge rejects — treat them as unparsable so the
  // preflight blocks instead of writing a broken (or silently defaulted) configuration.
  // Fractional seconds round UP so a tiny gate (e.g. `1ms`) stays a gate instead of being
  // disabled by rounding to zero.
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.ceil(seconds);
}

function readYarnrcYml(dirPath: string): Record<string, unknown> | typeof unparsableYarnrc | undefined {
  let yarnrcYml = '';
  try {
    yarnrcYml = fs.readFileSync(path.resolve(dirPath, '.yarnrc.yml'), 'utf8');
  } catch {
    // No .yarnrc.yml means there is no Yarn-specific configuration to preserve.
    return undefined;
  }
  if (!yarnrcYml) return undefined;
  try {
    const parsed = loadYaml(yarnrcYml);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return unparsableYarnrc;
  }
}

/**
 * wbfy assumes every managed repository uses Bun, so Yarn artifacts are always removed.
 * findUnmigratableYarnSettings must have passed before this runs.
 */
export async function removeYarnFiles(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('removeYarnFiles', async () => {
    // yarn.lock is deliberately kept while no Bun lockfile exists yet: `bun install` migrates a
    // yarn.lock into bun.lock only when bun.lock is absent, preserving the resolved dependency
    // versions. It is removed in index.ts right after the Bun lockfile has been refreshed.
    const fileNames = ['.yarnrc', '.yarnrc.yml', '.yarn'];
    if (
      fs.existsSync(path.resolve(config.dirPath, 'bun.lock')) ||
      fs.existsSync(path.resolve(config.dirPath, 'bun.lockb'))
    ) {
      fileNames.push('yarn.lock');
    }
    for (const fileName of fileNames) {
      await promisePool.run(() =>
        fs.promises.rm(path.resolve(config.dirPath, fileName), { force: true, recursive: true })
      );
    }
    const entries = await fs.promises.readdir(config.dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith('.pnp.')) continue;
      await promisePool.run(() =>
        fs.promises.rm(path.resolve(config.dirPath, entry.name), { force: true, recursive: true })
      );
    }
  });
}
