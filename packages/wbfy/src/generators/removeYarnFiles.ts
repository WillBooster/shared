import fs from 'node:fs';
import path from 'node:path';

import { load as loadYaml } from 'js-yaml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { promisePool } from '../utils/promisePool.js';

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
  'npmMinimalAgeGate',
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
  try {
    if (fs.readFileSync(path.resolve(dirPath, 'package.json'), 'utf8').includes('"patch:')) {
      reasons.push('package.json uses the patch: protocol');
    }
  } catch {
    // A missing package.json is reported by getPackageConfig later.
  }
  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

function isMigratableYarnrcSetting(key: string, value: unknown): boolean {
  // `enableScripts: false` is dropped deliberately even though Bun's default differs slightly
  // (Bun runs lifecycle scripts of its built-in default allow-list of popular packages): wbfy's
  // ensureTrustedDependencies fully owns trustedDependencies and deliberately restores Bun's
  // default allow-list (the ownership policy chosen in #975), so adopting that org baseline is
  // the intended outcome of the migration (#1014). An explicit `enableScripts: true` has no
  // automatic translation because Bun cannot enable all lifecycle scripts wholesale.
  if (key === 'enableScripts') return value === false;
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
      // Bun matches minimumReleaseAgeExcludes entries literally, so Yarn glob patterns
      // (e.g. `@willbooster/*`) would be dead configuration and are dropped. Dropping is
      // fail-safe (an uncovered package becomes age-gated, which surfaces at install time
      // instead of weakening the gate), and the org-standard globs are already covered
      // literally by bunMinimumReleaseAgeExcludes.
      (entry): entry is string => typeof entry === 'string' && !/[*?{[\]]/u.test(entry)
    );
  }
  return settings;
}

function parseYarnDurationAsSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Math.round(value * 60);
  if (typeof value !== 'string') return undefined;
  const match = /^(?<num>\d*\.?\d+)(?<unit>[a-z]*)$/u.exec(value.trim());
  const num = match?.groups?.num;
  if (num === undefined) return undefined;
  const multiplier = match?.groups?.unit ? yarnDurationUnitsInSeconds[match.groups.unit] : 60;
  if (multiplier === undefined) return undefined;
  return Math.round(Number.parseFloat(num) * multiplier);
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
