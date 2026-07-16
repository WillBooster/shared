import fs from 'node:fs';
import path from 'node:path';

import { load as loadYaml } from 'js-yaml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { promisePool } from '../utils/promisePool.js';

// Yarn settings wbfy can safely drop when migrating to Bun: tooling and cosmetics that do not
// change what gets installed. Anything else (registries, auth, scopes, packageExtensions,
// patchFolder, enableScripts, proxies, supportedArchitectures, ...) affects dependency
// resolution or install behavior and requires manual migration.
const safeYarnrcSettings = new Set([
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
  'plugins',
  'preferInteractive',
  'progressBarStyle',
  'yarnPath',
]);

/**
 * Detects Yarn configuration that has no automatic Bun translation. Must run as a read-only
 * preflight BEFORE any fixer mutates the repository: deleting such configuration (or migrating
 * everything around it) would break installs or silently drop patched dependency behavior.
 * @return A human-readable reason when the repository needs manual migration, otherwise undefined.
 */
export function findUnmigratableYarnSettings(dirPath: string): string | undefined {
  let yarnrcYml = '';
  try {
    yarnrcYml = fs.readFileSync(path.resolve(dirPath, '.yarnrc.yml'), 'utf8');
  } catch {
    // No .yarnrc.yml means there is no Yarn-specific configuration to preserve.
  }
  if (yarnrcYml) {
    let parsed: unknown;
    try {
      parsed = loadYaml(yarnrcYml);
    } catch {
      return '.yarnrc.yml is unparsable';
    }
    if (parsed && typeof parsed === 'object') {
      const unsafeSettings = Object.keys(parsed).filter((key) => !safeYarnrcSettings.has(key));
      if (unsafeSettings.length > 0) {
        return `.yarnrc.yml declares behavior-affecting settings [${unsafeSettings.join(', ')}]`;
      }
    }
  }
  if (fs.existsSync(path.resolve(dirPath, '.yarn', 'patches'))) {
    return '.yarn/patches exists';
  }
  try {
    if (fs.readFileSync(path.resolve(dirPath, 'package.json'), 'utf8').includes('"patch:')) {
      return 'package.json uses the patch: protocol';
    }
  } catch {
    // A missing package.json is reported by getPackageConfig later.
  }
  return undefined;
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
