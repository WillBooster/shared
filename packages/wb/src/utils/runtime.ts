import fs from 'node:fs';
import path from 'node:path';

export function usesBunRuntime(dirPath: string): boolean {
  // Mirrors Project.usesBunPackageManager: the outermost packageManager declaration (the
  // workspace root's) takes precedence over nested ones, and an explicit non-Bun declaration
  // wins over the directory markers. The walk therefore collects signals up to the repository
  // root instead of deciding at the first hit, so a child workspace cannot override the root.
  let outermostPackageManager: unknown;
  let hasSomeBunDirectoryMarker = false;
  for (let currentPath = path.resolve(dirPath); ; currentPath = path.dirname(currentPath)) {
    const packageManager = readPackageManagerField(path.join(currentPath, 'package.json'));
    if (packageManager !== undefined) outermostPackageManager = packageManager;
    hasSomeBunDirectoryMarker ||= hasBunDirectoryMarker(currentPath);
    if (fs.existsSync(path.join(currentPath, '.git')) || path.dirname(currentPath) === currentPath) {
      if (isExplicitNonBunPackageManager(outermostPackageManager)) return false;
      return hasSomeBunDirectoryMarker || isBunPackageManager(outermostPackageManager);
    }
  }
}

/**
 * Whether the directory carries a bun marker: a bun lockfile, a mise-pinned bun, or a
 * `.tool-versions` bun entry. wbfy migrates .tool-versions into mise.toml, so a mise-pinned bun
 * must count as well: repos that gitignore bun.lock and have no packageManager field rely on the
 * tool manifest. This is the single signal list deciding bun-vs-yarn; `Project.usesBunPackageManager`
 * and `usesBunRuntime` share it — and both give an explicit non-Bun packageManager declaration
 * precedence over it (see isExplicitNonBunPackageManager) — so the two detections cannot drift.
 */
export function hasBunDirectoryMarker(dirPath: string): boolean {
  return (
    ['bun.lock', 'bun.lockb'].some((fileName) => fs.existsSync(path.join(dirPath, fileName))) ||
    ['mise.toml', '.mise.toml'].some((fileName) =>
      testFileContent(path.join(dirPath, fileName), /^\s*(?:"bun"|bun)\s*=/m)
    ) ||
    testFileContent(path.join(dirPath, '.tool-versions'), /(^|\n)bun\s/)
  );
}

/**
 * An explicit non-Bun packageManager declaration (e.g. `yarn@4.17.0`) overrides the directory
 * markers: yarn-era repositories may pin bun in mise.toml solely for `bunx`-based helpers
 * (e.g. `wb railway-env`), and Bun-managed repositories never declare a non-Bun packageManager
 * (wbfy deletes the field).
 */
export function isExplicitNonBunPackageManager(packageManager: unknown): boolean {
  return typeof packageManager === 'string' && !!packageManager.trim() && !isBunPackageManager(packageManager);
}

export function isBunPackageManager(packageManager: unknown): boolean {
  return typeof packageManager === 'string' && packageManager.startsWith('bun@');
}

function readPackageManagerField(packageJsonPath: string): unknown {
  try {
    return (JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { packageManager?: unknown }).packageManager;
  } catch {
    return undefined;
  }
}

function testFileContent(filePath: string, pattern: RegExp): boolean {
  try {
    return pattern.test(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
}
